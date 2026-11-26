import crypto from 'node:crypto';
import JSZip from 'jszip';

export async function createSampleProjectArchive(): Promise<{
  buffer: Buffer;
  digest: string;
  fileCount: number;
  totalBytes: number;
}> {
  const zip = new JSZip();

  const files: Record<string, string> = {
    'docker-compose.yml': [
      'services:',
      '  api:',
      '    build: ./backend',
      '    ports:',
      '      - "8000:8000"',
      '    environment:',
      '      - DATABASE_URL=${DATABASE_URL}',
      '  web:',
      '    build: ./frontend',
      '    ports:',
      '      - "3000:3000"',
      '    depends_on:',
      '      - api',
    ].join('\n'),

    '.env.example': [
      'DATABASE_URL=postgresql://localhost:5432/inventory_pulse',
      'SESSION_SECRET=replace-with-random-secret',
    ].join('\n'),

    'backend/requirements.txt': [
      'fastapi>=0.115,<1.0',
      'uvicorn[standard]>=0.30,<1.0',
      'pydantic>=2.0,<3.0',
    ].join('\n'),

    'backend/app/main.py': [
      'import os',
      'from fastapi import FastAPI, HTTPException',
      'from .auth import verify_session',
      'from .store import get_inventory_items, create_inventory_item',
      'from .service import calculate_reorder_alerts',
      '',
      'app = FastAPI(title="Inventory Pulse API")',
      'DB_URL = os.environ.get("DATABASE_URL", "sqlite:///local.db")',
      '',
      '@app.get("/api/health")',
      'def health_check():',
      '    return {"status": "ok", "service": "inventory-pulse"}',
      '',
      '@app.get("/api/items")',
      'def list_items(token: str = ""):',
      '    verify_session(token)',
      '    items = get_inventory_items()',
      '    alerts = calculate_reorder_alerts(items)',
      '    return {"items": items, "alerts": alerts}',
      '',
      '@app.post("/api/items")',
      'def add_item(name: str, quantity: int, token: str = ""):',
      '    verify_session(token)',
      '    if quantity < 0:',
      '        raise HTTPException(status_code=400, detail="Quantity cannot be negative")',
      '    return create_inventory_item(name, quantity)',
    ].join('\n'),

    'backend/app/auth.py': [
      'import os',
      'from fastapi import HTTPException',
      '',
      'SESSION_SECRET = os.environ.get("SESSION_SECRET", "")',
      '',
      'def verify_session(token: str) -> str:',
      '    if not token or len(token) < 8:',
      '        raise HTTPException(status_code=401, detail="Missing or invalid session token")',
      '    return "workspace-admin"',
    ].join('\n'),

    'backend/app/store.py': [
      'from typing import List, Dict',
      '',
      'INVENTORY_DB: List[Dict[str, object]] = [',
      '    {"sku": "SKU-101", "name": "Thermal Sensor", "quantity": 18, "threshold": 20},',
      '    {"sku": "SKU-204", "name": "Relay Module", "quantity": 42, "threshold": 15},',
      ']',
      '',
      'def get_inventory_items() -> List[Dict[str, object]]:',
      '    return list(INVENTORY_DB)',
      '',
      'def create_inventory_item(name: str, quantity: int) -> Dict[str, object]:',
      '    record = {"sku": f"SKU-{len(INVENTORY_DB) + 300}", "name": name, "quantity": quantity, "threshold": 10}',
      '    INVENTORY_DB.append(record)',
      '    return record',
    ].join('\n'),

    'backend/app/service.py': [
      'from typing import List, Dict',
      'from .store import get_inventory_items',
      '',
      'def calculate_reorder_alerts(items: List[Dict[str, object]] | None = None) -> List[str]:',
      '    source = items if items is not None else get_inventory_items()',
      '    return [',
      '        str(item["sku"])',
      '        for item in source',
      '        if int(item.get("quantity", 0)) < int(item.get("threshold", 10))',
      '    ]',
    ].join('\n'),

    'frontend/package.json': JSON.stringify(
      {
        name: 'inventory-pulse-ui',
        private: true,
        version: '1.0.0',
        scripts: {
          dev: 'vite --port 3000',
          build: 'vite build',
          start: 'vite preview',
        },
        dependencies: {
          react: '^19.0.0',
          'react-dom': '^19.0.0',
          'lucide-react': '^0.500.0',
        },
        devDependencies: {
          vite: '^6.0.0',
          typescript: '^5.6.0',
        },
      },
      null,
      2,
    ),

    'frontend/src/api.ts': [
      'export interface InventoryItem {',
      '  sku: string;',
      '  name: string;',
      '  quantity: number;',
      '  threshold: number;',
      '}',
      '',
      'export async function fetchInventory(): Promise<{ items: InventoryItem[]; alerts: string[] }> {',
      '  const res = await fetch("/api/items");',
      '  if (!res.ok) throw new Error("Failed to load inventory");',
      '  return res.json();',
      '}',
    ].join('\n'),

    'frontend/src/components/InventoryTable.tsx': [
      "import type { InventoryItem } from '../api';",
      '',
      'export function InventoryTable({ items, alerts }: { items: InventoryItem[]; alerts: string[] }) {',
      '  return (',
      '    <table>',
      '      <tbody>',
      '        {items.map(item => (',
      '          <tr key={item.sku}>',
      '            <td>{item.sku}</td>',
      '            <td>{item.name}</td>',
      '            <td>{alerts.includes(item.sku) ? "Low Stock" : "Healthy"}</td>',
      '          </tr>',
      '        ))}',
      '      </tbody>',
      '    </table>',
      '  );',
      '}',
    ].join('\n'),

    'frontend/src/App.tsx': [
      "import { useEffect, useState } from 'react';",
      "import { fetchInventory, type InventoryItem } from './api';",
      "import { InventoryTable } from './components/InventoryTable';",
      '',
      'export function App() {',
      '  const [items, setItems] = useState<InventoryItem[]>([]);',
      '  const [alerts, setAlerts] = useState<string[]>([]);',
      '',
      '  useEffect(() => {',
      '    void fetchInventory().then(data => {',
      '      setItems(data.items);',
      '      setAlerts(data.alerts);',
      '    });',
      '  }, []);',
      '',
      '  return <InventoryTable items={items} alerts={alerts} />;',
      '}',
    ].join('\n'),
  };

  let totalBytes = 0;
  for (const [filePath, content] of Object.entries(files)) {
    zip.file(filePath, content);
    totalBytes += Buffer.byteLength(content, 'utf8');
  }

  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const digest = crypto.createHash('sha256').update(buffer).digest('hex');

  return {
    buffer,
    digest,
    fileCount: Object.keys(files).length,
    totalBytes,
  };
}

export async function createStaticPortalSampleArchive(): Promise<{
  buffer: Buffer;
  digest: string;
  fileCount: number;
  totalBytes: number;
}> {
  const zip = new JSZip();

  const files: Record<string, string> = {
    'index.html': `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Campus Telemetry Portal</title>
    <link rel="stylesheet" href="styles.css" />
  </head>
  <body>
    <main class="shell">
      <header class="head">
        <div>
          <span class="kicker">SANDBOXED STATIC DEPLOYMENT</span>
          <h1>Campus Compute &amp; Lab Status</h1>
        </div>
        <button id="refreshBtn" type="button">Refresh Checks</button>
      </header>
      <section class="grid" id="cards"></section>
    </main>
    <script src="app.js"></script>
  </body>
</html>`,
    'styles.css': `body { margin: 0; font-family: system-ui, sans-serif; background: #0b0f14; color: #e5ece9; }
.shell { max-width: 840px; margin: 40px auto; padding: 24px; }
.head { display: flex; justify-content: space-between; align-items: center; gap: 16px; border-bottom: 1px solid #243038; padding-bottom: 16px; }
.kicker { font-size: 11px; letter-spacing: 0.08em; color: #6ee7b7; font-family: monospace; }
h1 { margin: 6px 0 0; font-size: 26px; }
button { background: #10b981; color: #052e1f; border: 0; border-radius: 6px; padding: 10px 16px; font-weight: 600; cursor: pointer; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; margin-top: 24px; }
.card { background: #131a21; border: 1px solid #25303a; border-radius: 8px; padding: 16px; }
.card strong { display: block; font-size: 15px; margin-bottom: 6px; }
.card span { font-size: 13px; color: #94a3b8; }`,
    'app.js': `const nodes = [
  { name: 'Inference Cluster A', status: 'Healthy · 14 ms response' },
  { name: 'Snapshot Archive Store', status: 'Healthy · Verified SHA-256' },
  { name: 'Sandbox Edge Proxy', status: 'Healthy · HTTPS ready' },
];
function render() {
  const el = document.getElementById('cards');
  el.innerHTML = nodes.map(n => '<article class="card"><strong>' + n.name + '</strong><span>' + n.status + '</span></article>').join('');
}
document.getElementById('refreshBtn').addEventListener('click', render);
render();`,
    'package.json': JSON.stringify(
      {
        name: 'campus-telemetry-portal',
        version: '1.0.0',
        scripts: {
          build: 'echo "Static assets verified"',
          start: 'npx serve .',
        },
      },
      null,
      2,
    ),
  };

  let totalBytes = 0;
  for (const [filePath, content] of Object.entries(files)) {
    zip.file(filePath, content);
    totalBytes += Buffer.byteLength(content, 'utf8');
  }

  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const digest = crypto.createHash('sha256').update(buffer).digest('hex');

  return {
    buffer,
    digest,
    fileCount: Object.keys(files).length,
    totalBytes,
  };
}
