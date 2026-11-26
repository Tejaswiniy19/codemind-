import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import {
  ArrowDownLeft,
  ArrowUpRight,
  Braces,
  ChevronRight,
  FileCode2,
  GitBranch,
  Network,
  Search,
  ShieldAlert,
} from 'lucide-react';
import './AnalysisExplorer.css';

export type AnalysisEvidence = {
  path?: string;
  line?: number | null;
  line_start?: number;
  line_end?: number;
  method?: string;
  claim?: string;
};

export type AnalysisFile = {
  path: string;
  language: string;
  parser: string;
  lines?: number;
  bytes?: number;
  role: string;
  role_confidence?: number;
  role_evidence?: AnalysisEvidence;
};

export type AnalysisSymbol = {
  id?: string;
  path: string;
  name: string;
  qualified_name?: string;
  kind: string;
  line_start: number;
  line_end?: number;
  evidence?: AnalysisEvidence;
};

export type AnalysisRelationship = {
  type: string;
  source_path: string;
  target_path?: string | null;
  target_module?: string;
  target_name?: string;
  resolved: boolean;
  confidence?: number;
  evidence?: AnalysisEvidence;
};

export type AnalysisFramework = {
  name: string;
  confidence?: number;
  evidence?: AnalysisEvidence[];
};

export type AnalysisFeature = {
  name: string;
  grouping_basis?: string;
  files: string[];
  observed_symbols?: number;
  symbols?: number;
  confidence?: number;
};

export type AnalysisResult = {
  status?: string;
  file_count?: number;
  analyzed_source_files?: number;
  symbol_count?: number;
  relationship_count?: number;
  files: AnalysisFile[];
  symbols?: AnalysisSymbol[];
  relationships?: AnalysisRelationship[];
  frameworks?: AnalysisFramework[];
  features?: AnalysisFeature[];
  languages?: {
    supported_languages?: Record<
      string,
      { analyzed_files?: number; parser?: string; depth?: string; limitations?: string[] }
    >;
    detected_languages?: Record<string, number>;
    unsupported_language_extensions?: Record<string, number>;
    skipped_ignored_files?: number;
    skipped_oversized_files?: number;
    skipped_analysis_budget_files?: number;
    skipped_binary_or_non_utf8_files?: number;
  };
  limitations?: string[];
};

type SourcePreview = {
  path: string;
  snapshot_id: string;
  digest: string;
  start_line: number;
  end_line: number;
  total_lines: number;
  lines: { number: number; text: string }[];
};

export function AnalysisExplorer({
  result,
  projectId,
  snapshotId,
  initialView = 'files',
}: {
  result: AnalysisResult;
  projectId: string;
  snapshotId?: string;
  initialView?: 'files' | 'graph';
}) {
  const [query, setQuery] = useState('');
  const [language, setLanguage] = useState('all');
  const [selectedPath, setSelectedPath] = useState(() => result.files[0]?.path ?? '');
  const [tab, setTab] = useState<'file' | 'impact' | 'features'>('file');
  const [view, setView] = useState<'files' | 'graph'>(initialView);
  const [sourcePreview, setSourcePreview] = useState<SourcePreview | null>(null);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [sourceError, setSourceError] = useState('');
  const [sourceStartInput, setSourceStartInput] = useState(1);
  const [sourceRequestedStart, setSourceRequestedStart] = useState(1);

  useEffect(() => {
    setView(initialView);
  }, [initialView, projectId]);

  const languages = useMemo(
    () => Array.from(new Set(result.files.map((file) => file.language))).sort(),
    [result.files],
  );

  const filteredFiles = useMemo(() => {
    const q = query.trim().toLowerCase();
    return result.files.filter((file) => {
      if (language !== 'all' && file.language !== language) return false;
      if (!q) return true;
      return file.path.toLowerCase().includes(q) || file.role.toLowerCase().includes(q);
    });
  }, [result.files, query, language]);

  const activePath = filteredFiles.some((file) => file.path === selectedPath)
    ? selectedPath
    : (filteredFiles[0]?.path ?? '');
  const activeFile = result.files.find((file) => file.path === activePath);
  const symbols = result.symbols ?? [];
  const relationships = result.relationships ?? [];
  const fileSymbols = symbols.filter((symbol) => symbol.path === activePath);
  const outgoing = relationships.filter((edge) => edge.source_path === activePath);
  const incoming = relationships.filter((edge) => edge.target_path === activePath && edge.resolved);
  const resolvedIncomingFiles = Array.from(new Set(incoming.map((edge) => edge.source_path))).sort();
  const frameworks = result.frameworks ?? [];
  const features = result.features ?? [];
  const filePathSet = useMemo(() => new Set(result.files.map((f) => f.path)), [result.files]);

  useEffect(() => {
    if (!activePath) {
      setSourcePreview(null);
      return;
    }
    const controller = new AbortController();
    const params = new URLSearchParams({ path: activePath, start_line: String(sourceRequestedStart) });
    if (snapshotId) params.set('snapshot_id', snapshotId);
    setSourceLoading(true);
    setSourceError('');
    fetch(`/api/projects/${encodeURIComponent(projectId)}/source?${params.toString()}`, {
      credentials: 'same-origin',
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(typeof payload.detail === 'string' ? payload.detail : 'Could not load this source preview.');
        }
        return payload as SourcePreview;
      })
      .then((payload) => {
        setSourcePreview(payload);
        setSourceStartInput(payload.start_line);
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setSourcePreview(null);
        setSourceError(error instanceof Error ? error.message : 'Could not load this source preview.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setSourceLoading(false);
      });
    return () => controller.abort();
  }, [activePath, projectId, snapshotId, sourceRequestedStart]);

  useEffect(() => {
    setSourceStartInput(1);
    setSourceRequestedStart(1);
  }, [activePath]);

  useEffect(() => {
    const openGraph = () => setView('graph');
    window.addEventListener('codemind:show-architecture-graph', openGraph);
    return () => window.removeEventListener('codemind:show-architecture-graph', openGraph);
  }, []);

  function jumpToFile(targetPath: string, line = 1) {
    if (!filePathSet.has(targetPath)) return;
    setQuery('');
    setLanguage('all');
    setSelectedPath(targetPath);
    setTab('file');
    setView('files');
    setSourceStartInput(line);
    setSourceRequestedStart(line);
  }

  return (
    <section id="analysis-explorer" className="analysis-explorer" aria-label="Static project analysis">
      <header className="ae-header">
        <div>
          <div className="ae-eyebrow">
            <Braces size={13} /> STATIC PROJECT MAP
          </div>
          <h2>How this project is organized</h2>
          <p>Source-backed file roles, symbols, and references. Inferences are labeled and may be incomplete.</p>
        </div>
        <div className="ae-summary" aria-label="Analysis totals">
          <div>
            <strong>{(result.file_count ?? result.files.length).toLocaleString()}</strong>
            <span>PROJECT FILES</span>
          </div>
          <div>
            <strong>{symbols.length.toLocaleString()}</strong>
            <span>SYMBOLS FOUND</span>
          </div>
          <div>
            <strong>{relationships.length.toLocaleString()}</strong>
            <span>REFERENCES</span>
          </div>
        </div>
      </header>

      <div className="ae-chip-row">
        {(result.languages?.supported_languages ? Object.entries(result.languages.supported_languages) : []).map(
          ([name, info]) => (
            <span className="ae-chip" key={name}>
              <i />
              {name}
              <small>{info.depth}</small>
            </span>
          ),
        )}
        {frameworks.map((framework) => (
          <span className="ae-chip ae-framework" key={framework.name}>
            {framework.name}
            <small>{Math.round((framework.confidence ?? 0) * 100)}% signal</small>
          </span>
        ))}
        <span className="ae-static-note">
          <ShieldAlert size={13} /> Uploaded code was not executed
        </span>
      </div>

      <div className="ae-view-switch" role="group" aria-label="Project map view">
        <button
          type="button"
          className={view === 'files' ? 'active' : ''}
          aria-pressed={view === 'files'}
          onClick={() => setView('files')}
        >
          <FileCode2 size={13} /> File explorer
        </button>
        <button
          type="button"
          className={view === 'graph' ? 'active' : ''}
          aria-pressed={view === 'graph'}
          onClick={() => setView('graph')}
        >
          <Network size={13} /> Architecture graph
        </button>
      </div>

      {view === 'graph' ? (
        <ArchitectureGraph
          result={result}
          selectedPath={activePath}
          onSelectPath={(path) => {
            setSelectedPath(path);
            setQuery('');
            setLanguage('all');
          }}
          onOpenFile={() => {
            setTab('file');
            setView('files');
          }}
        />
      ) : (
        <div className="ae-workbench">
          <aside className="ae-file-panel" aria-label="Project files">
            <div className="ae-file-panel-head">
              <span>ANALYZED FILES</span>
              <strong>{filteredFiles.length}</strong>
            </div>
            <label className="ae-search">
              <Search size={14} />
              <span className="sr-only">Search files</span>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search paths or roles"
              />
            </label>
            <label className="ae-language-filter">
              <span className="sr-only">Filter by language</span>
              <select value={language} onChange={(event) => setLanguage(event.target.value)}>
                <option value="all">All analyzed languages</option>
                {languages.map((item) => (
                  <option key={item}>{item}</option>
                ))}
              </select>
            </label>
            <div className="ae-file-list">
              {filteredFiles.map((file) => {
                const count = symbols.reduce((total, symbol) => total + Number(symbol.path === file.path), 0);
                return (
                  <button
                    key={file.path}
                    type="button"
                    className={`ae-file-row ${activePath === file.path ? 'active' : ''}`}
                    onClick={() => {
                      setSelectedPath(file.path);
                      setTab('file');
                    }}
                    aria-pressed={activePath === file.path}
                  >
                    <FileCode2 size={14} />
                    <span className="ae-file-row-copy">
                      <strong title={file.path}>{file.path.split('/').slice(-1)[0]}</strong>
                      <small title={file.path}>
                        {file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : file.role}
                      </small>
                    </span>
                    <span className="ae-symbol-count" title={`${count} extracted symbols`}>
                      {count}
                    </span>
                  </button>
                );
              })}
              {filteredFiles.length === 0 && (
                <div className="ae-empty">
                  <p>No analyzed files match this search.</p>
                  <button
                    type="button"
                    className="ae-symbol-jump"
                    onClick={() => {
                      setQuery('');
                      setLanguage('all');
                    }}
                  >
                    Reset filters
                  </button>
                </div>
              )}
            </div>
            {result.languages?.unsupported_language_extensions &&
              Object.keys(result.languages.unsupported_language_extensions).length > 0 && (
                <div className="ae-coverage-note">
                  Also detected, not deeply parsed:{' '}
                  {Object.entries(result.languages.unsupported_language_extensions)
                    .map(([ext, count]) => `${ext} (${count})`)
                    .join(', ')}
                </div>
              )}
          </aside>

          <div className="ae-detail-panel">
            {activeFile ? (
              <>
                <div className="ae-detail-top">
                  <div className="ae-file-title">
                    <span className="ae-file-icon">
                      <FileCode2 size={17} />
                    </span>
                    <div>
                      <h3>{activeFile.path.split('/').slice(-1)[0]}</h3>
                      <code>{activeFile.path}</code>
                    </div>
                  </div>
                  <span className="ae-language-tag">{activeFile.language}</span>
                </div>
                <div className="ae-role-card">
                  <span>
                    LIKELY RESPONSIBILITY <small>{Math.round((activeFile.role_confidence ?? 0) * 100)}% confidence</small>
                  </span>
                  <strong>{activeFile.role}</strong>
                  <p>
                    This is a structural hint based on file names, paths, and static syntax. Confirm it against the
                    source before making changes.
                  </p>
                </div>
                <div className="ae-tabs" role="tablist" aria-label="File analysis views">
                  <button role="tab" type="button" aria-selected={tab === 'file'} onClick={() => setTab('file')}>
                    File details <span>{fileSymbols.length}</span>
                  </button>
                  <button role="tab" type="button" aria-selected={tab === 'impact'} onClick={() => setTab('impact')}>
                    Change impact <span>{resolvedIncomingFiles.length}</span>
                  </button>
                  <button
                    role="tab"
                    type="button"
                    aria-selected={tab === 'features'}
                    onClick={() => setTab('features')}
                  >
                    Feature groups <span>{features.filter((feature) => feature.files.includes(activePath)).length}</span>
                  </button>
                </div>

                {tab === 'file' && (
                  <div className="ae-tab-content">
                    <div className="ae-detail-stats">
                      <div>
                        <span>LINES</span>
                        <strong>{activeFile.lines?.toLocaleString() ?? '—'}</strong>
                      </div>
                      <div>
                        <span>SYMBOLS FOUND</span>
                        <strong>{fileSymbols.length}</strong>
                      </div>
                      <div>
                        <span>OUTGOING REFERENCES</span>
                        <strong>{outgoing.length}</strong>
                      </div>
                    </div>
                    <div className="ae-subsection ae-source-section">
                      <div className="ae-section-title">
                        <strong>Source evidence</strong>
                        <span>
                          {sourcePreview ? `${sourcePreview.total_lines.toLocaleString()} lines` : 'Snapshot text preview'}
                        </span>
                      </div>
                      <form
                        className="ae-source-controls"
                        onSubmit={(event) => {
                          event.preventDefault();
                          setSourceRequestedStart(Math.max(1, Math.floor(sourceStartInput)));
                        }}
                      >
                        <label>
                          Start at line{' '}
                          <input
                            type="number"
                            min={1}
                            max={activeFile.lines ?? 1}
                            value={sourceStartInput}
                            onChange={(event) => setSourceStartInput(Number(event.target.value))}
                          />
                        </label>
                        <button type="submit" disabled={sourceLoading}>
                          Show up to 200 lines
                        </button>
                      </form>
                      <p className="ae-source-caption">
                        Read from the immutable snapshot used for this analysis. Text previews are bounded and displayed
                        without execution.
                      </p>
                      {sourceLoading && (
                        <p className="ae-source-feedback" role="status">
                          Loading source from this snapshot…
                        </p>
                      )}
                      {sourceError && (
                        <p className="ae-source-feedback error" role="alert">
                          {sourceError}
                        </p>
                      )}
                      {sourcePreview && (
                        <pre
                          className="ae-source-code"
                          aria-label={`Source lines ${sourcePreview.start_line} to ${sourcePreview.end_line}`}
                        >
                          <code>
                            {sourcePreview.lines.map((line) => (
                              <span className="ae-source-line" key={line.number}>
                                <span className="ae-source-line-number">{line.number}</span>
                                <span>{line.text || ' '}</span>
                              </span>
                            ))}
                          </code>
                        </pre>
                      )}
                    </div>
                    <div className="ae-subsection">
                      <div className="ae-section-title">
                        <strong>Defined symbols</strong>
                        <span>{fileSymbols.length} found</span>
                      </div>
                      {fileSymbols.length ? (
                        <div className="ae-symbol-list">
                          {fileSymbols.slice(0, 60).map((symbol) => (
                            <div
                              className="ae-symbol"
                              key={symbol.id ?? `${symbol.path}:${symbol.name}:${symbol.line_start}`}
                            >
                              <span className="ae-symbol-kind">{symbol.kind.split('_').join(' ')}</span>
                              <strong>{symbol.qualified_name ?? symbol.name}</strong>
                              <button
                                type="button"
                                className="ae-symbol-jump"
                                title="Jump to line in source preview"
                                onClick={() => {
                                  setSourceStartInput(symbol.line_start);
                                  setSourceRequestedStart(symbol.line_start);
                                }}
                              >
                                L{symbol.line_start}
                                {symbol.line_end && symbol.line_end !== symbol.line_start ? `-${symbol.line_end}` : ''}
                              </button>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="ae-empty">
                          No symbols were extracted from this file. It may be a manifest or unsupported syntax.
                        </p>
                      )}
                    </div>
                    <div className="ae-subsection">
                      <div className="ae-section-title">
                        <strong>References from this file</strong>
                        <span>{outgoing.length} found</span>
                      </div>
                      {outgoing.length ? (
                        <div className="ae-reference-list">
                          {outgoing.slice(0, 40).map((edge, index) => (
                            <Reference
                              key={`${edge.type}-${edge.target_name ?? edge.target_module ?? edge.target_path}-${index}`}
                              edge={edge}
                              direction="out"
                              onOpenPath={
                                edge.target_path && filePathSet.has(edge.target_path)
                                  ? () => jumpToFile(edge.target_path!)
                                  : undefined
                              }
                            />
                          ))}
                        </div>
                      ) : (
                        <p className="ae-empty">No static outgoing references were resolved for this file.</p>
                      )}
                    </div>
                  </div>
                )}

                {tab === 'impact' && (
                  <div className="ae-tab-content">
                    <div className="ae-impact-callout">
                      <ShieldAlert size={16} />
                      <p>
                        These are <strong>known incoming static references</strong> to this file. They suggest places to
                        inspect if you change it; they do not guarantee runtime impact or prove that other files are
                        unaffected.
                      </p>
                    </div>
                    {resolvedIncomingFiles.length ? (
                      <div className="ae-impact-list">
                        {resolvedIncomingFiles.map((path) => {
                          const edges = incoming.filter((edge) => edge.source_path === path);
                          return (
                            <button
                              type="button"
                              className="ae-impact-row"
                              key={path}
                              onClick={() => {
                                setSelectedPath(path);
                                setTab('file');
                              }}
                            >
                              <ArrowDownLeft size={15} />
                              <span>
                                <strong>{path}</strong>
                                <small>{edges.map((edge) => edge.type.split('_').join(' ')).join(' / ')}</small>
                              </span>
                              <span className="ae-impact-count">
                                {edges.length} link{edges.length === 1 ? '' : 's'}
                              </span>
                              <ChevronRight size={14} />
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="ae-no-impact">
                        <GitBranch size={19} />
                        <strong>No resolved incoming references found</strong>
                        <p>
                          This does not mean the file is unused. Dynamic imports, reflection, generated code, runtime
                          wiring, or unsupported syntax may not appear in this static map.
                        </p>
                      </div>
                    )}
                    <div className="ae-subsection">
                      <div className="ae-section-title">
                        <strong>Unresolved references from this file</strong>
                        <span>{outgoing.filter((edge) => !edge.resolved).length}</span>
                      </div>
                      {outgoing
                        .filter((edge) => !edge.resolved)
                        .slice(0, 20)
                        .map((edge, index) => (
                          <Reference key={`unresolved-${index}`} edge={edge} direction="out" />
                        ))}
                    </div>
                  </div>
                )}

                {tab === 'features' && (
                  <div className="ae-tab-content">
                    {features.filter((feature) => feature.files.includes(activePath)).length ? (
                      features
                        .filter((feature) => feature.files.includes(activePath))
                        .map((feature) => (
                          <article className="ae-feature-card" key={feature.name}>
                            <div>
                              <span>LIKELY FEATURE GROUP</span>
                              <small>{Math.round((feature.confidence ?? 0) * 100)}% confidence</small>
                            </div>
                            <h4>{feature.name}</h4>
                            <p>
                              Grouped from directory and file-role patterns; this is not a verified product feature
                              boundary.
                            </p>
                            <strong>
                              {feature.files.length} related files · {feature.observed_symbols ?? feature.symbols ?? 0}{' '}
                              extracted symbols
                            </strong>
                            <div className="ae-feature-files">
                              {feature.files.slice(0, 20).map((path) => (
                                <button
                                  type="button"
                                  key={path}
                                  onClick={() => {
                                    setSelectedPath(path);
                                    setTab('file');
                                  }}
                                >
                                  {path}
                                  <ChevronRight size={12} />
                                </button>
                              ))}
                            </div>
                          </article>
                        ))
                    ) : (
                      <p className="ae-empty roomy">
                        No feature group currently includes this file. Grouping is heuristic and may be incomplete.
                      </p>
                    )}
                  </div>
                )}
              </>
            ) : (
              <div className="ae-no-impact ae-no-selection">
                <FileCode2 size={22} />
                <strong>No files to display</strong>
                <p>This analysis did not return any supported source files.</p>
              </div>
            )}
          </div>
        </div>
      )}

      {result.limitations?.length ? (
        <details className="ae-limitations">
          <summary>Analysis scope and limitations</summary>
          <ul>
            {result.limitations.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

type GraphNode = { path: string; file: AnalysisFile; x: number; y: number; degree: number };
type GraphEdge = {
  source_path: string;
  target_path: string;
  type: string;
  confidence: number;
  evidence?: AnalysisEvidence;
  count: number;
};

export function ArchitectureGraph({
  result,
  selectedPath,
  onSelectPath,
  onOpenFile,
}: {
  result: AnalysisResult;
  selectedPath: string;
  onSelectPath: (path: string) => void;
  onOpenFile: () => void;
}) {
  const graph = useMemo(() => {
    const fileByPath = new Map(result.files.map((file) => [file.path, file]));
    const grouped = new Map<string, GraphEdge>();
    for (const edge of result.relationships ?? []) {
      const target = edge.target_path;
      if (!edge.resolved || !target || !fileByPath.has(edge.source_path) || !fileByPath.has(target) || target === edge.source_path) {
        continue;
      }
      const key = `${edge.source_path}\u0000${target}`;
      const previous = grouped.get(key);
      if (previous) {
        previous.count += 1;
        if ((edge.confidence ?? 0) > previous.confidence) {
          previous.confidence = edge.confidence ?? 0;
          previous.evidence = edge.evidence;
        }
      } else {
        grouped.set(key, {
          source_path: edge.source_path,
          target_path: target,
          type: edge.type,
          confidence: edge.confidence ?? 0,
          evidence: edge.evidence,
          count: 1,
        });
      }
    }
    const allEdges = Array.from(grouped.values());
    const degree = new Map<string, number>();
    for (const edge of allEdges) {
      degree.set(edge.source_path, (degree.get(edge.source_path) ?? 0) + edge.count);
      degree.set(edge.target_path, (degree.get(edge.target_path) ?? 0) + edge.count);
    }
    const paths = Array.from(degree.keys()).sort((a, b) => (degree.get(b) ?? 0) - (degree.get(a) ?? 0) || a.localeCompare(b));
    const visiblePaths = paths.slice(0, 28);
    const centerX = 450;
    const centerY = 270;
    const radius = visiblePaths.length <= 8 ? 150 : 218;
    const nodes: GraphNode[] = visiblePaths.map((path, index) => {
      const angle = -Math.PI / 2 + (2 * Math.PI * index) / Math.max(visiblePaths.length, 1);
      return {
        path,
        file: fileByPath.get(path)!,
        x: centerX + Math.cos(angle) * radius,
        y: centerY + Math.sin(angle) * radius,
        degree: degree.get(path) ?? 0,
      };
    });
    const visibleSet = new Set(visiblePaths);
    const edges = allEdges.filter((edge) => visibleSet.has(edge.source_path) && visibleSet.has(edge.target_path));
    return {
      nodes,
      edges,
      connectedFileCount: paths.length,
      omittedFiles: Math.max(0, paths.length - nodes.length),
      omittedEdges: Math.max(0, allEdges.length - edges.length),
    };
  }, [result.files, result.relationships]);

  const selectedNode = graph.nodes.find((node) => node.path === selectedPath) ?? graph.nodes[0];
  const selectedEdges = selectedNode
    ? graph.edges.filter((edge) => edge.source_path === selectedNode.path || edge.target_path === selectedNode.path)
    : [];
  const pathLabel = (path: string) => path.split('/').slice(-1)[0] || path;
  const fileColor = (language: string) => language.toLowerCase().replace(/[^a-z]/g, '');
  const handleNodeKey = (event: KeyboardEvent<SVGGElement>, path: string) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelectPath(path);
    }
  };

  return (
    <section className="ae-graph-view" aria-label="Static architecture relationship graph">
      <div className="ae-graph-heading">
        <div>
          <span>
            <Network size={14} /> RESOLVED FILE RELATIONSHIPS
          </span>
          <p>
            Edges show statically resolved references between analyzed files. Click any node to inspect its symbols and
            connections.
          </p>
        </div>
        <div className="ae-graph-counts">
          <strong>
            {graph.nodes.length}
            <small> files shown</small>
          </strong>
          <strong>
            {graph.edges.length}
            <small> links shown</small>
          </strong>
        </div>
      </div>

      {graph.nodes.length ? (
        <div className="ae-graph-layout">
          <div className="ae-graph-canvas-wrap">
            <svg
              className="ae-graph-canvas"
              viewBox="0 0 900 540"
              role="group"
              aria-label={`Graph of ${graph.nodes.length} connected project files and ${graph.edges.length} resolved links`}
            >
              <defs>
                <marker
                  id="ae-graph-arrow"
                  viewBox="0 0 10 10"
                  refX="8"
                  refY="5"
                  markerWidth="5"
                  markerHeight="5"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 0 L 10 5 L 0 10 z" />
                </marker>
              </defs>
              {graph.edges.map((edge, index) => {
                const source = graph.nodes.find((node) => node.path === edge.source_path)!;
                const target = graph.nodes.find((node) => node.path === edge.target_path)!;
                const dx = target.x - source.x;
                const dy = target.y - source.y;
                const length = Math.max(Math.hypot(dx, dy), 1);
                const startX = source.x + (dx / length) * 21;
                const startY = source.y + (dy / length) * 21;
                const endX = target.x - (dx / length) * 25;
                const endY = target.y - (dy / length) * 25;
                const selected = selectedNode?.path === edge.source_path || selectedNode?.path === edge.target_path;
                return (
                  <line
                    key={`${edge.source_path}:${edge.target_path}:${index}`}
                    className={`ae-graph-edge ${selected ? 'related' : ''} ${edge.type}`}
                    x1={startX}
                    y1={startY}
                    x2={endX}
                    y2={endY}
                    strokeWidth={Math.min(3, 1 + Math.log2(edge.count))}
                    markerEnd="url(#ae-graph-arrow)"
                  >
                    <title>
                      {edge.source_path} → {edge.target_path}; {edge.count} resolved reference
                      {edge.count === 1 ? '' : 's'}; confidence {Math.round(edge.confidence * 100)}%
                    </title>
                  </line>
                );
              })}
              {graph.nodes.map((node) => {
                const angle = Math.atan2(node.y - 270, node.x - 450);
                const labelX = node.x + Math.cos(angle) * 31;
                const labelY = node.y + Math.sin(angle) * 31 + 3;
                const anchor = Math.cos(angle) > 0.35 ? 'start' : Math.cos(angle) < -0.35 ? 'end' : 'middle';
                const selected = selectedNode?.path === node.path;
                return (
                  <g
                    key={node.path}
                    className={`ae-graph-node ${selected ? 'selected' : ''} lang-${fileColor(node.file.language)}`}
                    role="button"
                    tabIndex={0}
                    aria-label={`${node.file.path}. ${node.file.role}. ${node.degree} resolved references.`}
                    aria-pressed={selected}
                    onClick={() => onSelectPath(node.path)}
                    onKeyDown={(event) => handleNodeKey(event, node.path)}
                  >
                    <title>
                      {node.file.path} — {node.file.role} — {node.degree} resolved references
                    </title>
                    <circle cx={node.x} cy={node.y} r={19} />
                    <text x={node.x} y={node.y + 3}>
                      {node.file.language.slice(0, 2).toUpperCase()}
                    </text>
                    <text className="ae-graph-label" x={labelX} y={labelY} textAnchor={anchor}>
                      {pathLabel(node.path).slice(0, 21)}
                      {pathLabel(node.path).length > 21 ? '…' : ''}
                    </text>
                  </g>
                );
              })}
            </svg>
            <div className="ae-graph-legend">
              <span>
                <i className="python" /> Python
              </span>
              <span>
                <i className="javascript" /> JS / TS
              </span>
              <span>
                <i className="java" /> Java
              </span>
              <span>
                <i className="edge-key" /> Resolved static reference
              </span>
            </div>
          </div>

          <aside className="ae-graph-detail" aria-live="polite">
            {selectedNode ? (
              <>
                <div className="ae-graph-detail-kicker">SELECTED FILE</div>
                <h3>{pathLabel(selectedNode.path)}</h3>
                <code>{selectedNode.path}</code>
                <div className="ae-graph-role">
                  <span>{selectedNode.file.language}</span>
                  <span>{Math.round((selectedNode.file.role_confidence ?? 0) * 100)}% heuristic confidence</span>
                  <strong>Likely role: {selectedNode.file.role}</strong>
                  <small>
                    {selectedNode.file.role_evidence?.claim ?? 'Role is inferred from repository structure and static patterns.'}
                    {selectedNode.file.role_evidence?.method ? ` · ${selectedNode.file.role_evidence.method}` : ''}
                  </small>
                </div>
                <p className="ae-graph-caveat">
                  These links are static-analysis evidence. Dynamic imports, reflection, runtime wiring, and unsupported
                  syntax may be missing.
                </p>
                {(result.symbols ?? []).filter((symbol) => symbol.path === selectedNode.path).length > 0 && (
                  <div className="ae-graph-detail-links">
                    <strong>Symbols observed in this file</strong>
                    {(result.symbols ?? [])
                      .filter((symbol) => symbol.path === selectedNode.path)
                      .slice(0, 8)
                      .map((symbol, index) => (
                        <div
                          className="ae-graph-symbol"
                          key={symbol.id ?? `${symbol.path}:${symbol.name}:${symbol.line_start}:${index}`}
                        >
                          <span>{symbol.qualified_name ?? symbol.name}</span>
                          <small>
                            {symbol.kind.replace(/_/g, ' ')} · L{symbol.evidence?.line_start ?? symbol.line_start}
                            {symbol.evidence?.line_end && symbol.evidence.line_end !== symbol.line_start
                              ? `-${symbol.evidence.line_end}`
                              : ''}
                          </small>
                        </div>
                      ))}
                  </div>
                )}
                <div className="ae-graph-detail-links">
                  <strong>Observed connections ({selectedEdges.length})</strong>
                  {selectedEdges.slice(0, 12).map((edge, index) => {
                    const outgoing = edge.source_path === selectedNode.path;
                    const otherPath = outgoing ? edge.target_path : edge.source_path;
                    return (
                      <button
                        type="button"
                        key={`${otherPath}:${edge.type}:${index}`}
                        onClick={() => onSelectPath(otherPath)}
                      >
                        <span>
                          {outgoing ? '→' : '←'} {pathLabel(otherPath)}
                        </span>
                        <small>
                          {edge.type.replace(/_/g, ' ')} · {Math.round(edge.confidence * 100)}%
                          {edge.evidence?.line_start ? ` · L${edge.evidence.line_start}` : ''}
                        </small>
                        {edge.evidence?.claim ? <small className="ae-graph-evidence-claim">{edge.evidence.claim}</small> : null}
                      </button>
                    );
                  })}
                  {!selectedEdges.length && <span className="ae-graph-empty">No links in this graph.</span>}
                </div>
                <button type="button" className="ae-graph-open-file" onClick={onOpenFile}>
                  Open full file analysis <ChevronRight size={13} />
                </button>
              </>
            ) : (
              <p className="ae-graph-empty">No connected files are available to inspect.</p>
            )}
          </aside>
        </div>
      ) : (
        <div className="ae-graph-empty-state">
          <Network size={22} />
          <strong>No resolved file links found</strong>
          <p>
            There are no relationships that connect analyzed files in this snapshot. This does not prove the files are
            unrelated or unused.
          </p>
        </div>
      )}

      {(graph.omittedFiles > 0 || graph.omittedEdges > 0) && (
        <p className="ae-graph-truncation">
          Large project view is bounded to the 28 most-connected files. This view omits {graph.omittedFiles} connected
          files and {graph.omittedEdges} links; the file explorer retains the full analyzed inventory.
        </p>
      )}
      {graph.nodes.length > 0 && graph.nodes.length <= 28 && graph.connectedFileCount < result.files.length && (
        <p className="ae-graph-truncation">
          Showing {graph.connectedFileCount} files with resolved links;{' '}
          {result.files.length - graph.connectedFileCount} other analyzed files have no resolved connection in this
          graph.
        </p>
      )}
      <details className="ae-graph-accessible-list">
        <summary>Browse graph connections as a list</summary>
        <ul>
          {graph.edges.map((edge, index) => (
            <li key={`${edge.source_path}:${edge.target_path}:${index}`}>
              <button type="button" onClick={() => onSelectPath(edge.source_path)}>
                {edge.source_path}
              </button>{' '}
              <span>→</span>{' '}
              <button type="button" onClick={() => onSelectPath(edge.target_path)}>
                {edge.target_path}
              </button>
              <small>
                {edge.type.replace(/_/g, ' ')} · {Math.round(edge.confidence * 100)}% confidence
                {edge.evidence?.line_start ? ` · line ${edge.evidence.line_start}` : ''}
              </small>
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}

function Reference({
  edge,
  direction,
  onOpenPath,
}: {
  edge: AnalysisRelationship;
  direction: 'in' | 'out';
  onOpenPath?: () => void;
}) {
  const path = direction === 'in' ? edge.source_path : edge.target_path;
  const line = edge.evidence?.line_start ?? edge.evidence?.line;
  const lineLabel = line
    ? `L${line}${edge.evidence?.line_end && edge.evidence.line_end !== line ? `–${edge.evidence.line_end}` : ''}`
    : null;
  const content = (
    <>
      <span className="ae-reference-icon">
        {direction === 'in' ? <ArrowDownLeft size={13} /> : <ArrowUpRight size={13} />}
      </span>
      <span className="ae-reference-copy">
        <strong>{path ?? edge.target_module ?? edge.target_name ?? 'Unresolved target'}</strong>
        <small>
          {edge.type.split('_').join(' ')}
          {edge.evidence?.claim ? ` / ${edge.evidence.claim}` : ''}
        </small>
      </span>
      <span className={`ae-confidence ${edge.resolved ? 'resolved' : ''}`}>
        {Math.round((edge.confidence ?? 0) * 100)}%
      </span>
      {lineLabel && <code>{lineLabel}</code>}
    </>
  );

  if (onOpenPath) {
    return (
      <button type="button" className="ae-reference clickable" onClick={onOpenPath}>
        {content}
      </button>
    );
  }
  return <div className="ae-reference">{content}</div>;
}

export default AnalysisExplorer;
