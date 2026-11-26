import { ChangeEvent, DragEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity, ArrowDownToLine, ArrowRight, Boxes, Check, ChevronDown, CircleHelp, Code2,
  FileArchive, FolderGit2, GitBranch, Layers3, LockKeyhole, Plus, Search,
  LogOut, Server, Settings2, ShieldCheck, Sparkles, Upload, X,
} from 'lucide-react'
import { AnalysisExplorer, type AnalysisResult } from './AnalysisExplorer'
import './NetworkConsent.css'
import { ProjectQA } from './ProjectQA'
// import './DeploymentLogs.css'

type Job = {
  id: string
  kind: 'analysis' | 'deployment'
  status: string
  message: string
  result?: AnalysisResult | DeploymentPlanView | null
}
type DeploymentPlanView = {
  status?: string
  reason?: string
  snapshot_id?: string
  source_digest?: string
  candidates?: { stack: string; runtime_family: string; build_recipe_id?: string | null; start_recipe_id?: string | null; package_manager?: string | null; entrypoint_hint?: string | null; manifest_paths?: string[]; confidence?: string; notes?: string[] }[]
  requires_isolated_runner?: boolean
  requires_review?: boolean
  runner?: { status?: string; message?: string; url?: string | null; logs?: string | null }
}
type Project = {
  id: string
  name: string
  created_at: string
  snapshot_id?: string
  digest?: string
  file_count?: number
  total_bytes?: number
  jobs?: Job[]
}

const API_URL = import.meta.env.VITE_API_URL ?? ''

function App({ csrfToken, onLogout, username }: { csrfToken: string; onLogout: () => Promise<void>; username: string }) {
  const [projects, setProjects] = useState<Project[]>([])
  const [selectedProject, setSelectedProject] = useState<Project | null>(null)
  const [explain, setExplain] = useState(true)
  const [deploy, setDeploy] = useState(false)
  const [allowBuildDownloads, setAllowBuildDownloads] = useState(false)
  const [projectName, setProjectName] = useState('')
  const [zipFile, setZipFile] = useState<File | null>(null)
  const [folderFiles, setFolderFiles] = useState<File[]>([])
  const [uploading, setUploading] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [query, setQuery] = useState('')
  const zipInput = useRef<HTMLInputElement>(null)
  const folderInput = useRef<HTMLInputElement>(null)

  const refreshProjects = useCallback(async () => {
    try {
      const response = await fetch(`${API_URL}/api/projects`)
      if (response.status === 401) { window.location.reload(); return [] }
      if (!response.ok) throw new Error('Could not load projects')
      const items: Project[] = await response.json()
      setProjects(items)
      return items
    } catch {
      setError('API is not connected. Start the CodeMind API to create and analyze projects.')
      return []
    }
  }, [])

  useEffect(() => { void refreshProjects() }, [refreshProjects])

  useEffect(() => {
    if (!selectedProject) return
    let alive = true
    const fetchSelected = async () => {
      try {
        const response = await fetch(`${API_URL}/api/projects/${selectedProject.id}`, { credentials: 'same-origin' })
        if (response.status === 401) { window.location.reload(); return }
        if (!response.ok) return
        const data = await response.json()
        if (!alive) return
        const snapshot = data.snapshots?.[0]
        const latest: Project = { ...data, snapshot_id: snapshot?.id, digest: snapshot?.digest, file_count: snapshot?.file_count, total_bytes: snapshot?.total_bytes, jobs: snapshot?.jobs ?? [] }
        setSelectedProject(latest)
      } catch { /* Keep the last known project state visible during a brief API interruption. */ }
    }
    void fetchSelected()
    const timer = window.setInterval(() => { void fetchSelected() }, 5000)
    return () => { alive = false; window.clearInterval(timer) }
  }, [selectedProject?.id])

  const filteredProjects = useMemo(() => projects.filter(project => project.name.toLowerCase().includes(query.toLowerCase())), [projects, query])

  function clearSource() {
    setZipFile(null)
    setFolderFiles([])
    if (zipInput.current) zipInput.current.value = ''
    if (folderInput.current) folderInput.current.value = ''
  }

  function selectZip(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return
    setZipFile(file)
    setFolderFiles([])
    setProjectName(value => value || file.name.replace(/\.zip$/i, ''))
    setError('')
  }

  function selectFolder(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? [])
    if (!files.length) return
    setFolderFiles(files)
    setZipFile(null)
    setProjectName(value => value || files[0].webkitRelativePath.split('/')[0] || 'New project')
    setError('')
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    setDragging(false)
    const files = Array.from(event.dataTransfer.files)
    const zip = files.find(file => file.name.toLowerCase().endsWith('.zip'))
    if (zip) {
      setZipFile(zip)
      setFolderFiles([])
      setProjectName(value => value || zip.name.replace(/\.zip$/i, ''))
    } else if (files.length) {
      setError('For folder drag and drop, choose “Select project folder” so relative paths are preserved. You can also drop a ZIP here.')
    }
  }

  async function startProject() {
    if (!explain && !deploy) { setError('Choose Explain project, Deploy project, or both.'); return }
    if (!zipFile && folderFiles.length === 0) { setError('Select a ZIP archive or a project folder first.'); return }
    setUploading(true)
    setError('')
    setNotice('')
    const form = new FormData()
    if (zipFile) form.append('archive', zipFile)
    else folderFiles.forEach(file => {
      form.append('files', file, file.name)
      form.append('paths', file.webkitRelativePath)
    })
    form.append('project_name', projectName.trim() || 'New project')
    form.append('analyze', String(explain))
    form.append('deploy', String(deploy))
    form.append('allow_outbound_network', String(deploy && allowBuildDownloads))
    try {
      const response = await fetch(`${API_URL}/api/projects`, { method: 'POST', credentials: 'same-origin', headers: { 'X-CSRF-Token': csrfToken }, body: form })
      const result = await response.json()
      if (!response.ok) throw new Error(result.detail ?? 'Project upload failed')
      const items = await refreshProjects()
      setSelectedProject({ ...result.project, snapshot_id: result.snapshot.id, digest: result.snapshot.digest, file_count: result.snapshot.file_count, total_bytes: result.snapshot.total_bytes, jobs: result.jobs })
      setNotice(`${projectName.trim() || result.project.name} added as an immutable snapshot.`)
      setProjectName('')
      clearSource()
      if (items.length === 0) await refreshProjects()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create project.')
    } finally { setUploading(false) }
  }

  async function openProject(project: Project) {
    setError('')
    try {
      const response = await fetch(`${API_URL}/api/projects/${project.id}`, { credentials: 'same-origin' })
      if (response.status === 401) { window.location.reload(); return }
      if (!response.ok) throw new Error('Could not open project')
      const data = await response.json()
      const snapshot = data.snapshots?.[0]
      setSelectedProject({ ...data, snapshot_id: snapshot?.id, digest: snapshot?.digest, file_count: snapshot?.file_count, total_bytes: snapshot?.total_bytes, jobs: snapshot?.jobs ?? [] })
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not open project.') }
  }

  const activeJobs = selectedProject?.jobs ?? []
  const analysisResult = activeJobs.find(job => job.kind === 'analysis')?.result
  const inventory = analysisResult && 'files' in analysisResult ? analysisResult : undefined
  const deploymentResult = activeJobs.find(job => job.kind === 'deployment')?.result
  const deploymentPlan = deploymentResult && 'candidates' in deploymentResult ? deploymentResult : undefined
  const selectedSource = zipFile ?? folderFiles[0]
  const sourceCount = zipFile ? 1 : folderFiles.length

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-lockup">
          <div className="brand-mark"><span /><span /><span /><span /></div>
          <div><div className="brand-name">codemind<span>ai</span></div><div className="brand-caption">SOFTWARE INTELLIGENCE</div></div>
        </div>
        <button className="workspace-select"><div className="workspace-avatar">C</div><span><strong>My workspace</strong><small>Self-hosted</small></span><ChevronDown size={15} /></button>
        <div className="side-label">WORKSPACE</div>
        <nav className="primary-nav">
          <button className="nav-item active"><Layers3 size={17} /><span>Projects</span><span className="nav-count">{projects.length}</span></button>
          <button className="nav-item" onClick={() => {
            if (!selectedProject) { setNotice('Open a project with a completed analysis to view its architecture graph.'); return }
            if (!inventory) { setNotice('The project analysis is still running or was not requested.'); return }
            window.dispatchEvent(new Event('codemind:show-architecture-graph'))
            document.getElementById('analysis-explorer')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
          }}><Boxes size={17} /><span>Architecture graph</span><span className="nav-pill">VIEW</span></button>
          <button className="nav-item" onClick={() => setNotice('Deployment history appears after a build runner is configured.')}><Activity size={17} /><span>Deployments</span></button>
        </nav>
        <div className="project-nav-head"><div className="side-label">YOUR PROJECTS</div><button className="icon-button tiny" title="New project" onClick={() => { setSelectedProject(null); clearSource(); window.scrollTo({ top: 0, behavior: 'smooth' }) }}><Plus size={15} /></button></div>
        <div className="project-search"><Search size={14} /><input aria-label="Search projects" value={query} onChange={event => setQuery(event.target.value)} placeholder="Find a project" /></div>
        <div className="project-list">
          {filteredProjects.map(project => <button key={project.id} className={`project-link ${selectedProject?.id === project.id ? 'selected' : ''}`} onClick={() => void openProject(project)}><span className="project-dot" /><span className="project-link-name">{project.name}</span><span className="project-branch"><GitBranch size={12} /></span></button>)}
          {filteredProjects.length === 0 && <div className="empty-projects">Your projects will show here.</div>}
        </div>
        <div className="sidebar-bottom">
          <div className="local-card"><div className="local-card-icon"><ShieldCheck size={16} /></div><div><strong>Your code stays yours</strong><span>Private, self-hosted workspace</span></div><span className="status-dot" /></div>
          <button className="nav-item muted" onClick={() => setNotice('Settings will be available as workspace administration is implemented.')}><Settings2 size={17} /><span>Settings</span></button>
          <button className="nav-item muted" onClick={() => setNotice('Help center is being prepared.')}><CircleHelp size={17} /><span>Help & support</span></button>
          <div className="profile-row"><div className="profile-avatar">{username.slice(0, 1).toUpperCase()}</div><div><strong>{username}</strong><small>Local administrator</small></div><button className="icon-button tiny" aria-label="Sign out" title="Sign out" onClick={() => void onLogout()}><LogOut size={14} /></button></div>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar"><div className="breadcrumb"><span>Workspace</span><span className="crumb-separator">/</span><strong>{selectedProject?.name ?? 'Projects'}</strong></div><div className="topbar-right"><span className="private-badge"><LockKeyhole size={12} /> PRIVATE WORKSPACE</span><button className="icon-button" aria-label="Help" onClick={() => setNotice('Your source stays on this self-hosted server. Uploaded code is not executed during analysis.')}><CircleHelp size={17} /></button><button className="icon-button signout-button" aria-label="Sign out" title="Sign out" onClick={() => void onLogout()}><LogOut size={16} /></button><div className="top-avatar" aria-label={`Signed in as ${username}`}>{username.slice(0, 1).toUpperCase()}</div></div></header>

        <div className="content-wrap">
          {selectedProject ? (
            <ProjectView project={selectedProject} inventory={inventory} deploymentPlan={deploymentPlan} csrfToken={csrfToken} onBack={() => setSelectedProject(null)} />
          ) : (
            <>
              <div className="eyebrow"><span className="eyebrow-line" /> YOUR PROJECT WORKSPACE <span className="eyebrow-line" /></div>
              <div className="hero-title-wrap"><h1>Know your code.<br /><span>Ship it with confidence.</span></h1><p>Understand what your project does, or deploy it. Do either one on its own, or run both on the same snapshot.</p></div>
              <div className="phase-banner"><div className="phase-indicator"><span className="phase-light" /> PHASE 02 <i /> STATIC PROJECT INTELLIGENCE</div><span>Evidence-backed file roles, symbols, and relationships</span></div>

              <section className="setup-card" aria-label="Add a project">
                <div className="setup-header"><div><div className="section-kicker">START WITH A PROJECT</div><h2>Bring your codebase in</h2><p>One upload. Pick the capabilities you want to run.</p></div><div className="step-mark"><span>01</span><div /> SNAPSHOT</div></div>
                <div className={`dropzone ${dragging ? 'dragging' : ''} ${selectedSource ? 'has-file' : ''}`} onDragOver={event => { event.preventDefault(); setDragging(true) }} onDragLeave={() => setDragging(false)} onDrop={handleDrop}>
                  <input ref={zipInput} className="visually-hidden" type="file" accept=".zip,application/zip" onChange={selectZip} />
                  <input ref={folderInput} className="visually-hidden" type="file" multiple aria-label="Select a project folder" {...({ webkitdirectory: '', directory: '' } as unknown as React.InputHTMLAttributes<HTMLInputElement>)} onChange={selectFolder} />
                  {selectedSource ? <>
                    <div className="file-icon"><FileArchive size={20} /></div>
                    <div className="selected-file"><strong>{zipFile?.name ?? selectedSource.webkitRelativePath.split('/')[0]}</strong><span>{zipFile ? formatBytes(zipFile.size) : `${sourceCount.toLocaleString()} files selected`} · ready to snapshot</span></div>
                    <button className="icon-button remove-file" title="Remove selected project" onClick={event => { event.stopPropagation(); clearSource() }}><X size={16} /></button>
                  </> : <>
                    <div className="upload-symbol"><Upload size={19} /></div><div className="drop-copy"><strong>Drop a project ZIP here</strong><span>or choose a ZIP archive or local project folder</span></div>
                    <div className="source-actions"><button className="button secondary small" onClick={() => zipInput.current?.click()}><FileArchive size={14} /> Browse ZIP</button><button className="button secondary small" onClick={() => folderInput.current?.click()}><FolderGit2 size={14} /> Select project folder</button></div>
                  </>}
                </div>
                <div className="project-name-row"><label htmlFor="project-name">PROJECT NAME</label><input id="project-name" value={projectName} onChange={event => setProjectName(event.target.value)} placeholder="e.g. inventory-dashboard" maxLength={100} /><span>Optional</span></div>
                <div className="capabilities-heading"><div><div className="section-kicker">CHOOSE YOUR CAPABILITIES</div><h3>What do you want to do?</h3></div><span className="independent-label"><span className="tiny-check"><Check size={10} /></span> Select either or both</span></div>
                <div className="capability-grid">
                  <CapabilityCard selected={explain} onClick={() => setExplain(value => !value)} icon={<Code2 size={20} />} index="01" title="Explain project" description="Map likely file responsibilities, symbols, imports, stack clues, and change-impact hints with source evidence." accent="mint" tags={['FILE ROLES', 'SOURCE EVIDENCE']} />
                  <CapabilityCard selected={deploy} onClick={() => setDeploy(value => !value)} icon={<ArrowDownToLine size={20} />} index="02" title="Deploy project" description="Inspect supported build recipes and deploy through a separately isolated runner." accent="violet" tags={['STACK INSPECTION', 'ISOLATED RUNNER']} status="RUNNER REQUIRED" />
                </div>
                {deploy && <label className="network-consent"><input type="checkbox" checked={allowBuildDownloads} onChange={event => setAllowBuildDownloads(event.target.checked)} /><span><strong>Allow package downloads during build</strong><small>Required for most projects. The runner must route this through its restricted egress proxy; project runtime networking remains isolated.</small></span></label>}
                <div className="selection-summary"><div className="selection-checks"><span className={explain ? 'checked' : ''}>{explain && <Check size={10} />}EXPLAIN</span><span className="plus-sign">+</span><span className={deploy ? 'checked deploy-check' : ''}>{deploy && <Check size={10} />}DEPLOY</span></div><p>{explain && deploy ? 'Both capabilities will use the same immutable project snapshot.' : explain ? 'Project explanation will run for this snapshot.' : deploy ? 'Deployment will run for this snapshot.' : 'Select at least one capability to continue.'}</p></div>
                {error && <div className="feedback error"><X size={15} />{error}</div>}{notice && <div className="feedback notice"><Sparkles size={15} />{notice}<button aria-label="Dismiss" onClick={() => setNotice('')}><X size={14} /></button></div>}
                <div className="submit-row"><div className="security-note"><ShieldCheck size={15} /><span>Private snapshot · source code is not executed during analysis</span></div><button className="button primary" disabled={uploading || (!explain && !deploy) || !selectedSource} onClick={() => void startProject()}>{uploading ? <><span className="spinner" /> Creating snapshot…</> : <>Create project snapshot <ArrowRight size={16} /></>}</button></div>
              </section>

              <section className="below-grid"><div className="mini-info"><div className="mini-icon mint-icon"><GitBranch size={17} /></div><div><strong>One snapshot, one source of truth</strong><p>Analysis and deployment stay tied to the exact project version you selected.</p></div></div><div className="mini-info"><div className="mini-icon blue-icon"><LockKeyhole size={17} /></div><div><strong>Built for self-hosting</strong><p>Your project archive is stored on your CodeMind server.</p></div></div></section>
              <div className="stack-footer"><span>ANALYSIS COVERAGE</span><div className="stack-divider" /><span className="stack-chip"><span className="stack-dot py" /> PYTHON AST</span><span className="stack-chip"><span className="stack-dot js" /> JAVASCRIPT</span><span className="stack-chip"><span className="stack-dot ts" /> TYPESCRIPT</span><span className="stack-chip"><span className="stack-dot java" /> JAVA</span><span className="stack-more">JS / TS / JAVA USE PARTIAL LEXICAL ANALYSIS</span></div>
            </>
          )}
          <footer className="page-footer"><span>CODEMIND AI <i>·</i> SELF-HOSTED SOFTWARE INTELLIGENCE</span><span>PHASE-WISE BUILD <i>·</i> 02 / 05</span></footer>
        </div>
      </main>
    </div>
  )
}

function CapabilityCard({ selected, onClick, icon, index, title, description, accent, tags, status }: { selected: boolean; onClick: () => void; icon: React.ReactNode; index: string; title: string; description: string; accent: string; tags: string[]; status?: string }) {
  return <button className={`capability-card ${selected ? 'selected' : ''} ${accent}`} aria-pressed={selected} onClick={onClick}><span className="card-index">{index} / CAPABILITY</span><span className={`select-indicator ${selected ? 'on' : ''}`}>{selected && <Check size={12} />}</span><span className="cap-icon">{icon}</span><span className="cap-title-row"><strong>{title}</strong>{status && <span className="coming-badge">{status}</span>}</span><span className="cap-description">{description}</span><span className="cap-bottom"><span className="cap-tags">{tags.map(tag => <span key={tag}>{tag}</span>)}</span><span className="toggle-track"><span /></span></span></button>
}

function ProjectView({ project, inventory, deploymentPlan, csrfToken, onBack }: { project: Project; inventory?: AnalysisResult; deploymentPlan?: DeploymentPlanView | null; csrfToken: string; onBack: () => void }) {
  const jobs = project.jobs ?? []
  const analysis = jobs.find(job => job.kind === 'analysis')
  const deployment = jobs.find(job => job.kind === 'deployment')
  return <div className="project-view"><button className="back-link" onClick={onBack}>← All projects</button><div className="project-view-heading"><div><div className="eyebrow left-eyebrow"><span className="eyebrow-line" /> PROJECT SNAPSHOT</div><h1>{project.name}</h1><p>Immutable source snapshot · {project.digest?.slice(0, 12) ?? 'pending digest'}</p></div><div className="snapshot-stamp"><span>SNAPSHOT</span><strong>{project.snapshot_id?.slice(0, 8) ?? project.id.slice(0, 8)}</strong></div></div>
    <div className="project-metrics"><div><span>FILES RECEIVED</span><strong>{(project.file_count ?? inventory?.file_count ?? 0).toLocaleString()}</strong></div><div><span>EXPANDED SIZE</span><strong>{formatBytes(project.total_bytes ?? 0)}</strong></div><div><span>ANALYSIS</span><strong className={analysis?.status === 'completed' ? 'success-text' : ''}>{analysis?.status ?? 'Not requested'}</strong></div><div><span>DEPLOYMENT</span><strong className={deployment?.status === 'blocked' ? 'muted-text' : ''}>{deployment?.status ?? 'Not requested'}</strong></div></div>
    <div className="job-grid">{analysis && <div className="job-card"><div className="job-card-title"><span className="job-icon mint-icon"><Code2 size={17} /></span><div><strong>Project explanation</strong><span>Static source analysis</span></div><StatusBadge status={analysis.status} /></div><p>{analysis.message}</p>{inventory && <div className="job-facts"><span>{inventory.symbol_count ?? 0} symbols</span><span>{inventory.relationship_count ?? 0} references</span><span>{inventory.analyzed_source_files ?? inventory.files.length} analyzed files</span></div>}</div>}{deployment && <div className="job-card"><div className="job-card-title"><span className="job-icon violet-icon"><Server size={17} /></span><div><strong>Project deployment</strong><span>{deploymentPlan?.runner?.status ? `Isolated runner · ${deploymentPlan.runner.status}` : 'Stack recipe inspection'}</span></div><StatusBadge status={deployment.status} /></div><p>{deployment.message}</p>{deploymentPlan?.candidates?.length ? <div className="deployment-candidates">{deploymentPlan.candidates.map((candidate, index) => <div className="candidate-card" key={`${candidate.runtime_family}-${candidate.manifest_paths?.join('-')}-${index}`}><strong>{candidate.stack}</strong><span>{candidate.runtime_family} runtime{candidate.package_manager ? ` · ${candidate.package_manager}` : ''}</span><small>{candidate.build_recipe_id ?? 'Build step needs configuration'} / {candidate.start_recipe_id ?? 'Start step needs configuration'}</small>{candidate.manifest_paths?.map(path => <code key={path}>{path}</code>)}</div>)}</div> : null}{deploymentPlan?.runner?.logs && <details className="deployment-logs"><summary>Build and runtime logs</summary><pre>{deploymentPlan.runner.logs}</pre></details>}<div className="runtime-note"><ShieldCheck size={16} /><span>{deploymentPlan?.runner?.message ?? deploymentPlan?.reason ?? 'Uploaded code remains unexecuted until a bounded, isolated build runner is configured.'}{deploymentPlan?.runner?.url && <> <a href={deploymentPlan.runner.url} target="_blank" rel="noopener noreferrer">Open deployed project</a></>}</span></div></div>}</div>
    {analysis?.status === 'completed' && inventory && <AnalysisExplorer result={inventory} projectId={project.id} snapshotId={project.snapshot_id} />}
    {analysis?.status === 'completed' && <ProjectQA key={`${project.id}:${project.snapshot_id ?? ''}`} projectId={project.id} snapshotId={project.snapshot_id} csrfToken={csrfToken} />}
    <div className="snapshot-details"><div><span>CREATED</span><strong>{project.created_at ? new Date(project.created_at).toLocaleString() : '—'}</strong></div><div><span>SNAPSHOT SHA-256</span><code>{project.digest ?? '—'}</code></div></div>
  </div>
}

function StatusBadge({ status }: { status: string }) {
  return <span className={`status-badge ${status}`}>{status === 'completed' ? <Check size={11} /> : status === 'blocked' ? <LockKeyhole size={11} /> : <span className="status-mini-dot" />}{status.toUpperCase()}</span>
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

export default App
