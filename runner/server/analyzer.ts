import path from 'node:path';
import JSZip from 'jszip';
import type {
  AnalysisFeature,
  AnalysisFile,
  AnalysisFramework,
  AnalysisRelationship,
  AnalysisResult,
  AnalysisSymbol,
} from './types.ts';

const IGNORED_PARTS = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'vendor',
  'dist',
  'build',
  'target',
  '__pycache__',
  '.venv',
  'venv',
  'coverage',
  '.next',
]);

const SOURCE_EXTENSIONS: Record<string, string> = {
  '.py': 'Python',
  '.js': 'JavaScript',
  '.jsx': 'JavaScript',
  '.mjs': 'JavaScript',
  '.cjs': 'JavaScript',
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript',
  '.mts': 'TypeScript',
  '.cts': 'TypeScript',
  '.java': 'Java',
};

const KNOWN_UNSUPPORTED_CODE_EXTENSIONS = new Set([
  '.go', '.rs', '.c', '.cc', '.cpp', '.h', '.hpp', '.cs', '.php', '.rb',
  '.swift', '.kt', '.kts', '.scala', '.sql', '.sh', '.dart', '.ex', '.exs',
]);

const MANIFEST_NAMES = new Set([
  'package.json',
  'pyproject.toml',
  'requirements.txt',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'settings.gradle',
  'settings.gradle.kts',
  'gradle.properties',
  'dockerfile',
  'docker-compose.yml',
  'docker-compose.yaml',
]);

const MAX_SOURCE_FILE = 512 * 1024;
const MAX_TOTAL_ANALYSIS_BYTES = 32 * 1024 * 1024;
const MAX_ANALYZED_FILES = 5000;

export function safePath(raw: string): string {
  const normalized = raw.replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length === 0 || parts.some((p) => p === '..' || p === '.')) {
    throw new Error('Invalid file path');
  }
  return parts.join('/');
}

function isIgnored(filePath: string): boolean {
  const parts = filePath.split('/');
  return parts.some((part) => IGNORED_PARTS.has(part) || part.startsWith('.DS_Store'));
}

function inferRole(filePath: string, language: string, source: string): { role: string; confidence: number; claim: string } {
  const lower = filePath.toLowerCase();
  const base = path.posix.basename(lower);

  if (MANIFEST_NAMES.has(base)) {
    return { role: 'Project manifest / build configuration', confidence: 0.96, claim: `Matched manifest filename ${base}` };
  }
  if (/(^|\/)(test|tests|__tests__|spec)\b|\.test\.|\.spec\.|_test\.py$/.test(lower)) {
    return { role: 'Likely test suite', confidence: 0.88, claim: 'Matched test path or filename convention' };
  }
  if (/(router|routes|controller|endpoint|api|main\.py|server\.ts|app\.py)/.test(lower) || /@app\.(get|post|put|delete)|app\.(get|post|put|delete)|APIRouter|express\(\)/.test(source)) {
    return { role: 'Likely API / routing layer', confidence: 0.84, claim: 'Detected route handlers or API entrypoint patterns' };
  }
  if (/\.(tsx|jsx)$/.test(lower) || /(component|page|view|screen|ui|frontend\/src\/)/.test(lower) || /export\s+(default\s+)?function\s+[A-Z]/.test(source)) {
    return { role: 'Likely UI component or view', confidence: 0.82, claim: 'Detected JSX/TSX or UI component structure' };
  }
  if (/(store|model|schema|db|database|repository|migration|sqlite|prisma|drizzle)/.test(lower)) {
    return { role: 'Likely data and persistence layer', confidence: 0.8, claim: 'Matched storage/model naming or persistence patterns' };
  }
  if (/(auth|session|security|middleware|guard)/.test(lower)) {
    return { role: 'Likely authentication & security module', confidence: 0.82, claim: 'Matched auth/session naming patterns' };
  }
  if (/(service|worker|task|analyzer|engine|qa|deploy|client|helper|util)/.test(lower)) {
    return { role: 'Likely service / business logic', confidence: 0.76, claim: 'Matched service or module path pattern' };
  }
  return {
    role: language === 'Configuration' ? 'Configuration file' : 'Likely application module',
    confidence: 0.58,
    claim: 'Inferred from repository location and syntax',
  };
}

function extractPythonDetails(filePath: string, source: string, symbols: AnalysisSymbol[], rawImports: Array<{ line: number; module: string; name?: string }>, frameworkSignals: Array<{ name: string; path: string; line: number; detail: string }>) {
  const lines = source.split(/\r?\n/);
  lines.forEach((line, idx) => {
    const lineNo = idx + 1;
    const classMatch = line.match(/^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)/);
    if (classMatch) {
      symbols.push({
        id: `${filePath}:${classMatch[1]}:${lineNo}`,
        path: filePath,
        name: classMatch[1],
        kind: 'class',
        line_start: lineNo,
        evidence: { line_start: lineNo, method: 'python_lexical' },
      });
    }
    const fnMatch = line.match(/^(\s*)(async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
    if (fnMatch) {
      const indented = fnMatch[1].length > 0;
      symbols.push({
        id: `${filePath}:${fnMatch[3]}:${lineNo}`,
        path: filePath,
        name: fnMatch[3],
        kind: indented ? 'method' : fnMatch[2] ? 'async_function' : 'function',
        line_start: lineNo,
        evidence: { line_start: lineNo, method: 'python_lexical' },
      });
    }
    const fromImport = line.match(/^\s*from\s+(\.{0,3}[A-Za-z0-9_.]*)\s+import\s+([A-Za-z0-9_.*, ]+)/);
    if (fromImport) {
      rawImports.push({ line: lineNo, module: fromImport[1], name: fromImport[2].trim() });
    } else {
      const stdImport = line.match(/^\s*import\s+([A-Za-z0-9_.]+)/);
      if (stdImport) {
        rawImports.push({ line: lineNo, module: stdImport[1] });
      }
    }
    if (/FastAPI\(|from\s+fastapi\b/.test(line)) {
      frameworkSignals.push({ name: 'FastAPI', path: filePath, line: lineNo, detail: 'FastAPI import or app instantiation' });
    }
    if (/from\s+flask\b|Flask\(/.test(line)) {
      frameworkSignals.push({ name: 'Flask', path: filePath, line: lineNo, detail: 'Flask import or app instantiation' });
    }
    if (/django/.test(line)) {
      frameworkSignals.push({ name: 'Django', path: filePath, line: lineNo, detail: 'Django reference' });
    }
  });
}

function extractJsTsDetails(filePath: string, source: string, symbols: AnalysisSymbol[], rawImports: Array<{ line: number; module: string }>, frameworkSignals: Array<{ name: string; path: string; line: number; detail: string }>) {
  const lines = source.split(/\r?\n/);
  lines.forEach((line, idx) => {
    const lineNo = idx + 1;
    const fnMatch = line.match(/^\s*(?:export\s+(?:default\s+)?)?(async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)/);
    if (fnMatch) {
      symbols.push({
        id: `${filePath}:${fnMatch[2]}:${lineNo}`,
        path: filePath,
        name: fnMatch[2],
        kind: fnMatch[1] ? 'async_function' : 'function',
        line_start: lineNo,
        evidence: { line_start: lineNo, method: 'js_ts_lexical' },
      });
    }
    const arrowMatch = line.match(/^\s*(?:export\s+)?const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s+)?\([^)]*\)\s*(?::[^=]+)?=>/);
    if (arrowMatch) {
      symbols.push({
        id: `${filePath}:${arrowMatch[1]}:${lineNo}`,
        path: filePath,
        name: arrowMatch[1],
        kind: 'function',
        line_start: lineNo,
        evidence: { line_start: lineNo, method: 'js_ts_lexical' },
      });
    }
    const classMatch = line.match(/^\s*(?:export\s+(?:default\s+)?)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)/);
    if (classMatch) {
      symbols.push({
        id: `${filePath}:${classMatch[1]}:${lineNo}`,
        path: filePath,
        name: classMatch[1],
        kind: 'class',
        line_start: lineNo,
        evidence: { line_start: lineNo, method: 'js_ts_lexical' },
      });
    }
    const typeMatch = line.match(/^\s*(?:export\s+)?(interface|type)\s+([A-Za-z_$][A-Za-z0-9_$]*)/);
    if (typeMatch) {
      symbols.push({
        id: `${filePath}:${typeMatch[2]}:${lineNo}`,
        path: filePath,
        name: typeMatch[2],
        kind: typeMatch[1] === 'interface' ? 'interface' : 'type_alias',
        line_start: lineNo,
        evidence: { line_start: lineNo, method: 'js_ts_lexical' },
      });
    }
    const importMatch = line.match(/^\s*import\s+(?:.+?\s+from\s+)?['"]([^'"]+)['"]/);
    if (importMatch) {
      rawImports.push({ line: lineNo, module: importMatch[1] });
    }
    const requireMatch = line.match(/require\(\s*['"]([^'"]+)['"]\s*\)/);
    if (requireMatch) {
      rawImports.push({ line: lineNo, module: requireMatch[1] });
    }
    if (/from\s+['"]react['"]/.test(line)) {
      frameworkSignals.push({ name: 'React', path: filePath, line: lineNo, detail: 'React import' });
    }
    if (/from\s+['"]express['"]|express\(\)/.test(line)) {
      frameworkSignals.push({ name: 'Express', path: filePath, line: lineNo, detail: 'Express server import or app' });
    }
  });
}

function extractJavaDetails(filePath: string, source: string, symbols: AnalysisSymbol[], rawImports: Array<{ line: number; module: string }>, frameworkSignals: Array<{ name: string; path: string; line: number; detail: string }>) {
  const lines = source.split(/\r?\n/);
  lines.forEach((line, idx) => {
    const lineNo = idx + 1;
    const classMatch = line.match(/\b(class|interface|enum|record)\s+([A-Za-z_][A-Za-z0-9_]*)/);
    if (classMatch) {
      symbols.push({
        id: `${filePath}:${classMatch[2]}:${lineNo}`,
        path: filePath,
        name: classMatch[2],
        kind: classMatch[1],
        line_start: lineNo,
        evidence: { line_start: lineNo, method: 'java_lexical' },
      });
    }
    const importMatch = line.match(/^\s*import\s+(?:static\s+)?([A-Za-z0-9_.*]+)\s*;/);
    if (importMatch) {
      rawImports.push({ line: lineNo, module: importMatch[1] });
    }
    if (/org\.springframework/.test(line)) {
      frameworkSignals.push({ name: 'Spring', path: filePath, line: lineNo, detail: 'Spring Framework import' });
    }
  });
}

function resolveImportTarget(sourcePath: string, spec: string, projectPaths: Set<string>, allPaths: string[]): string | null {
  if (spec.startsWith('.')) {
    const sourceDir = path.posix.dirname(sourcePath);
    const cleaned = spec.replace(/^\.(\/+)?/, './');
    const baseCandidate = path.posix.normalize(path.posix.join(sourceDir, cleaned));
    const candidates = [
      baseCandidate,
      `${baseCandidate}.ts`,
      `${baseCandidate}.tsx`,
      `${baseCandidate}.js`,
      `${baseCandidate}.jsx`,
      `${baseCandidate}.py`,
      `${baseCandidate}/index.ts`,
      `${baseCandidate}/index.tsx`,
      `${baseCandidate}/index.js`,
      `${baseCandidate}/__init__.py`,
    ];
    for (const candidate of candidates) {
      if (projectPaths.has(candidate)) return candidate;
    }
    // Python relative `from . import foo` where spec is `.`
    if (spec === '.') {
      const initCandidate = path.posix.join(sourceDir, '__init__.py');
      if (projectPaths.has(initCandidate)) return initCandidate;
    }
  }

  // Python dotted import e.g. `app.store` -> `app/store.py`
  const slashPath = spec.replace(/\./g, '/');
  for (const suffix of [`${slashPath}.py`, `${slashPath}.ts`, `${slashPath}.tsx`, `${slashPath}.js`]) {
    if (projectPaths.has(suffix)) return suffix;
    const nested = allPaths.filter((p) => p.endsWith('/' + suffix));
    if (nested.length === 1) return nested[0];
  }
  return null;
}

export async function analyzeSnapshotBuffer(archiveBuffer: Buffer): Promise<AnalysisResult> {
  const zip = await JSZip.loadAsync(archiveBuffer);
  const files: AnalysisFile[] = [];
  const symbols: AnalysisSymbol[] = [];
  const relationships: AnalysisRelationship[] = [];
  const documents = new Map<string, string>();
  const importsByFile = new Map<string, Array<{ line: number; module: string; name?: string }>>();
  const frameworkSignals: Array<{ name: string; path: string; line: number; detail: string }> = [];

  const languageCounts: Record<string, number> = {};
  const unsupportedExtensions: Record<string, number> = {};
  let skippedIgnored = 0;
  let skippedOversized = 0;
  let skippedBudget = 0;
  let skippedBinary = 0;
  let totalAnalyzedBytes = 0;
  let totalArchiveFiles = 0;

  const entries = Object.values(zip.files).filter((e) => !e.dir).sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    let normalized: string;
    try {
      normalized = safePath(entry.name);
    } catch {
      continue;
    }
    totalArchiveFiles += 1;
    if (isIgnored(normalized)) {
      skippedIgnored += 1;
      continue;
    }
    const ext = path.posix.extname(normalized).toLowerCase();
    const base = path.posix.basename(normalized).toLowerCase();
    const isManifest = MANIFEST_NAMES.has(base);
    const language = SOURCE_EXTENSIONS[ext] ?? (isManifest ? 'Configuration' : undefined);

    if (!language) {
      if (KNOWN_UNSUPPORTED_CODE_EXTENSIONS.has(ext)) {
        unsupportedExtensions[ext] = (unsupportedExtensions[ext] ?? 0) + 1;
      }
      continue;
    }
    if (files.length >= MAX_ANALYZED_FILES || totalAnalyzedBytes >= MAX_TOTAL_ANALYSIS_BYTES) {
      skippedBudget += 1;
      continue;
    }

    const rawBytes = await entry.async('nodebuffer');
    if (rawBytes.length > MAX_SOURCE_FILE) {
      skippedOversized += 1;
      continue;
    }
    if (rawBytes.includes(0)) {
      skippedBinary += 1;
      continue;
    }

    const source = rawBytes.toString('utf8');
    totalAnalyzedBytes += rawBytes.length;
    documents.set(normalized, source);
    languageCounts[language] = (languageCounts[language] ?? 0) + 1;

    const lineCount = source.length === 0 ? 0 : source.split(/\r?\n/).length;
    const roleInfo = inferRole(normalized, language, source);

    files.push({
      path: normalized,
      language,
      parser: language === 'Configuration' ? 'manifest_text' : 'lexical_scanner',
      lines: lineCount,
      bytes: rawBytes.length,
      role: roleInfo.role,
      role_confidence: roleInfo.confidence,
      role_evidence: { method: 'path_and_syntax_heuristic', claim: roleInfo.claim },
    });

    const fileImports: Array<{ line: number; module: string; name?: string }> = [];
    if (language === 'Python') {
      extractPythonDetails(normalized, source, symbols, fileImports, frameworkSignals);
    } else if (language === 'JavaScript' || language === 'TypeScript') {
      extractJsTsDetails(normalized, source, symbols, fileImports, frameworkSignals);
    } else if (language === 'Java') {
      extractJavaDetails(normalized, source, symbols, fileImports, frameworkSignals);
    }
    importsByFile.set(normalized, fileImports);
  }

  const projectPaths = new Set(files.map((f) => f.path));
  const allPaths = Array.from(projectPaths);

  for (const [sourcePath, rawImps] of importsByFile.entries()) {
    for (const imp of rawImps) {
      // Handle Python `from . import store, qa`
      let target = resolveImportTarget(sourcePath, imp.module, projectPaths, allPaths);
      if (!target && imp.module === '.' && imp.name) {
        const firstIdent = imp.name.split(',')[0].trim().split(/\s+/)[0];
        if (firstIdent) {
          target = resolveImportTarget(sourcePath, `./${firstIdent}`, projectPaths, allPaths);
        }
      }
      relationships.push({
        type: 'imports',
        source_path: sourcePath,
        target_path: target,
        target_module: imp.module,
        target_name: imp.name,
        resolved: Boolean(target),
        confidence: target ? 0.92 : 0.6,
        evidence: {
          line_start: imp.line,
          method: 'import_resolution',
          claim: target ? `Resolved import of ${imp.module}` : `External or unresolved import ${imp.module}`,
        },
      });
    }
  }

  // Detect frameworks from manifests & signals
  const frameworkMap = new Map<string, AnalysisFramework>();
  const addFramework = (name: string, confidence: number, pathStr: string, line: number | null, method: string, claim: string) => {
    const existing = frameworkMap.get(name) ?? { name, confidence, evidence: [] };
    existing.confidence = Math.max(existing.confidence ?? 0, confidence);
    if ((existing.evidence?.length ?? 0) < 15) {
      existing.evidence = [...(existing.evidence ?? []), { path: pathStr, line, method, claim }];
    }
    frameworkMap.set(name, existing);
  };

  for (const [docPath, source] of documents.entries()) {
    const base = path.posix.basename(docPath).toLowerCase();
    if (base === 'package.json') {
      try {
        const pkg = JSON.parse(source);
        const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}), ...(pkg.peerDependencies ?? {}) };
        const map: Record<string, string> = {
          react: 'React',
          next: 'Next.js',
          express: 'Express',
          vite: 'Vite',
          vue: 'Vue',
          '@angular/core': 'Angular',
          '@nestjs/core': 'NestJS',
          tailwindcss: 'Tailwind CSS',
        };
        for (const [dep, fw] of Object.entries(map)) {
          if (dep in deps) addFramework(fw, 0.98, docPath, null, 'package_manifest', `Declared dependency: ${dep}`);
        }
      } catch {
        // Ignore malformed package.json
      }
    } else if (base === 'requirements.txt' || base === 'pyproject.toml') {
      for (const [pkg, fw] of [['fastapi', 'FastAPI'], ['django', 'Django'], ['flask', 'Flask'], ['celery', 'Celery']] as const) {
        if (new RegExp(`\\b${pkg}\\b`, 'i').test(source)) {
          addFramework(fw, 0.95, docPath, null, 'python_manifest', `Declared dependency: ${pkg}`);
        }
      }
    } else if (base === 'pom.xml' || base === 'build.gradle' || base === 'build.gradle.kts') {
      if (/spring-boot|org\.springframework/i.test(source)) {
        addFramework('Spring', 0.9, docPath, null, 'java_manifest', 'Spring marker in build manifest');
      }
    }
  }

  for (const sig of frameworkSignals) {
    addFramework(sig.name, 0.72, sig.path, sig.line, 'source_pattern', sig.detail);
  }

  // Feature groupings
  const featureGroups = new Map<string, { name: string; files: Set<string>; symbols: number; confidence: number }>();
  for (const file of files) {
    const parts = file.path.split('/');
    let label = '';
    let confidence = 0.35;
    if (file.role.startsWith('Likely API')) label = 'API and routing';
    else if (file.role.startsWith('Likely UI')) label = 'User interface';
    else if (file.role.startsWith('Likely service')) label = 'Application services';
    else if (file.role.startsWith('Likely data')) label = 'Data and persistence';
    else if (file.role.startsWith('Likely auth')) label = 'Authentication & security';
    else if (file.role.startsWith('Likely test')) label = 'Testing & verification';
    else if (parts.length > 1) {
      label = parts[0];
      confidence = 0.25;
    }
    if (!label) continue;
    const entry = featureGroups.get(label) ?? { name: label, files: new Set<string>(), symbols: 0, confidence };
    entry.files.add(file.path);
    featureGroups.set(label, entry);
  }
  for (const sym of symbols) {
    for (const grp of featureGroups.values()) {
      if (grp.files.has(sym.path)) grp.symbols += 1;
    }
  }

  const features: AnalysisFeature[] = Array.from(featureGroups.values())
    .sort((a, b) => b.files.size - a.files.size || a.name.localeCompare(b.name))
    .map((g) => ({
      name: g.name,
      grouping_basis: 'file_role_or_directory',
      files: Array.from(g.files),
      observed_symbols: g.symbols,
      confidence: g.confidence,
    }));

  const supportedLanguages: Record<string, { analyzed_files: number; parser: string; depth: string; limitations: string[] }> = {};
  for (const file of files) {
    if (file.language === 'Configuration') continue;
    const entry = supportedLanguages[file.language] ?? {
      analyzed_files: 0,
      parser: file.parser,
      depth: 'lexical candidates',
      limitations: ['Static lexical scanning does not resolve runtime dynamic imports or reflection.'],
    };
    entry.analyzed_files += 1;
    supportedLanguages[file.language] = entry;
  }

  return {
    status: 'completed',
    file_count: totalArchiveFiles || files.length,
    analyzed_source_files: files.filter((f) => f.language !== 'Configuration').length,
    symbol_count: symbols.length,
    relationship_count: relationships.length,
    files,
    symbols,
    relationships,
    frameworks: Array.from(frameworkMap.values()).sort((a, b) => a.name.localeCompare(b.name)),
    features,
    languages: {
      supported_languages: supportedLanguages,
      detected_languages: languageCounts,
      unsupported_language_extensions: unsupportedExtensions,
      skipped_ignored_files: skippedIgnored,
      skipped_oversized_files: skippedOversized,
      skipped_analysis_budget_files: skippedBudget,
      skipped_binary_or_non_utf8_files: skippedBinary,
    },
    limitations: [
      'Static analysis inspects archived source text only; uploaded project code is never executed.',
      'Lexical scanners for Python, JavaScript, TypeScript, and Java may miss dynamic imports or metaprogramming.',
    ],
  };
}
