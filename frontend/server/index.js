import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {createPdf, createDocx} from './lib/exporters.js';
import {suggestedTitle,safeBaseName} from './lib/markdown.js';
import { fileURLToPath } from 'node:url';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dirname, '..');

function loadEnv() {
  const envFile = path.join(root, '.env');
  if (!fs.existsSync(envFile)) return;
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].trim().replace(/^(["'])(.*)\1$/, '$2');
    }
  }
}
loadEnv();

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '7mb' }));

const webhookUrl = (process.env.N8N_CHAT_URL || '').trim();
const port = Number(process.env.PORT || 4317);
const recentlySent = new Map();

function responseText(data) {
  if (Array.isArray(data)) return responseText(data[0]);
  if (typeof data === 'string') return data;
  if (!data || typeof data !== 'object') return null;
  for (const key of ['output', 'text', 'response', 'message', 'reply']) {
    if (typeof data[key] === 'string') return data[key];
  }
  if (data.json) return responseText(data.json);
  if (data.data) return responseText(data.data);
  return null;
}

function errorMessage(error) {
  if (error?.name === 'TimeoutError') return 'n8n tardó demasiado en responder. Revisa la ejecución del workflow.';
  if (error?.cause?.code === 'ECONNREFUSED') return 'No se pudo conectar con n8n. Comprueba Docker y el puerto 5678.';
  return 'No fue posible comunicarse con el agente. Revisa que el workflow esté publicado y la Chat URL sea correcta.';
}

app.get('/api/status', (_req, res) => {
  res.json({ configured: Boolean(webhookUrl), service: 'ISO Studio 2.0', connected: false, artifacts: ['pdf','docx'], diagrams: 'mermaid' });
});

app.post('/api/chat', async (req, res) => {
  const { message, sessionId } = req.body || {};
  if (typeof message !== 'string' || !message.trim() || message.length > 8000) {
    return res.status(400).json({ error: 'Escribe una consulta válida de hasta 8000 caracteres.' });
  }
  if (typeof sessionId !== 'string' || !/^[a-zA-Z0-9-]{8,100}$/.test(sessionId)) {
    return res.status(400).json({ error: 'Identificador de sesión no válido.' });
  }
  if (!webhookUrl) {
    return res.status(503).json({ error: 'Falta configurar N8N_CHAT_URL en el archivo .env. Puedes usar la vista previa mientras tanto.' });
  }
  // Evita usar el servidor como proxy hacia URLs configuradas accidentalmente fuera de la PC.
  let target;
  try {
    target = new URL(webhookUrl);
    if (!['127.0.0.1', 'localhost'].includes(target.hostname) || !['http:', 'https:'].includes(target.protocol)) {
      return res.status(503).json({ error: 'Por seguridad, la Chat URL debe apuntar a localhost o 127.0.0.1.' });
    }
  } catch {
    return res.status(503).json({ error: 'N8N_CHAT_URL no es una URL válida.' });
  }
  // Límite básico de uso local para evitar envíos involuntarios masivos.
  const now = Date.now();
  for (const [key, times] of recentlySent.entries()) {
    const active = times.filter(t => now - t < 60000);
    if (active.length) recentlySent.set(key, active);
    else recentlySent.delete(key);
  }
  const key = req.ip || 'local';
  const times = recentlySent.get(key) || [];
  if (times.length >= 18) return res.status(429).json({ error: 'Demasiadas consultas seguidas. Espera un minuto.' });
  recentlySent.set(key, [...times, now]);

  try {
    const upstream = await fetch(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ action: 'sendMessage', sessionId, chatInput: message.trim() }),
      signal: AbortSignal.timeout(110000),
    });
    const raw = await upstream.text();
    if (!upstream.ok) {
      const hint = upstream.status === 404 ? 'No se encuentra el webhook. Verifica que el workflow esté publicado y la URL sea la de producción.' :
        upstream.status === 500 ? 'n8n devolvió un error interno. Revisa Executions.' : `n8n devolvió HTTP ${upstream.status}. Comprueba Executions.`;
      return res.status(502).json({ error: hint });
    }
    let data;
    try { data = JSON.parse(raw); }
    catch { data = raw; }
    let answer = responseText(data);
    if (typeof answer === "string" && !answer.includes("\n") && answer.includes("\\n")) answer=answer.replace(/\\n/g,"\n");
    if (!answer) return res.status(502).json({ error: 'n8n respondió, pero no devolvió texto (output/text). Verifica Response Mode en Chat Trigger.' });
    return res.json({ answer, source: 'n8n' });
  } catch (err) {
    return res.status(502).json({ error: errorMessage(err) });
  }
});

// Artefactos generados localmente. No se aceptan rutas ni URLs externas del usuario.
const artifactDir = path.join(root, '.local-artifacts');
fs.mkdirSync(artifactDir, {recursive:true});
for (const file of fs.readdirSync(artifactDir)) {
  const location=path.join(artifactDir,file);
  try {if (Date.now()-fs.statSync(location).mtimeMs > 48*3600*1000) fs.unlinkSync(location);} catch {}
}
const artifactRate=new Map();
app.post('/api/artifacts', async (req,res)=>{
  const {format,markdown,title,diagrams=[]}=req.body||{};
  if(!['pdf','docx'].includes(format)) return res.status(400).json({error:'Formato no admitido. Usa pdf o docx.'});
  if(typeof markdown!=='string'||markdown.trim().length<1||markdown.length>90000) return res.status(400).json({error:'El documento debe contener entre 1 y 90 000 caracteres.'});
  if(typeof title!=='undefined'&&(typeof title!=='string'||title.length>180)) return res.status(400).json({error:'Título no válido.'});
  if(!Array.isArray(diagrams)||diagrams.length>4||diagrams.some(d=>!d||typeof d.png!=='string'||d.png.length>3200000)) return res.status(400).json({error:'Máximo cuatro imágenes PNG pequeñas por documento.'});
  const now=Date.now();const who=req.ip||'local';const count=(artifactRate.get(who)||[]).filter(t=>now-t<60000);
  if(count.length>=10)return res.status(429).json({error:'Demasiadas exportaciones. Espera un minuto.'});
  artifactRate.set(who,[...count,now]);
  try {
    const label=(title||suggestedTitle(markdown)).trim().slice(0,170)||'Documento ISO Studio';
    const bytes=format==='pdf'?await createPdf({title:label,markdown,diagrams}):await createDocx({title:label,markdown,diagrams});
    if(bytes.length>25_000_000) return res.status(413).json({error:'El archivo generado excede 25 MB.'});
    const id=crypto.randomUUID();const name=safeBaseName(label)+'.'+format;
    await fs.promises.writeFile(path.join(artifactDir,`${id}.${format}`),bytes,{flag:'wx'});
    res.json({id,name,format,size:bytes.length,url:`/api/artifacts/${id}/${format}`});
  } catch(err) {
    console.error('Artifact generation:',err.message);
    res.status(500).json({error:'No se pudo crear el archivo. Revisa el contenido o los diagramas e inténtalo de nuevo.'});
  }
});
app.get('/api/artifacts/:id/:format',(req,res)=>{
  const {id,format}=req.params;
  if(!/^[a-f0-9-]{36}$/.test(id)||!['pdf','docx'].includes(format))return res.sendStatus(404);
  const target=path.join(artifactDir,`${id}.${format}`);
  if(!fs.existsSync(target))return res.status(404).json({error:'Archivo no disponible o caducado.'});
  res.type(format==='pdf'?'application/pdf':'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.set('Content-Disposition',`attachment; filename="ISO-Studio-${id.slice(0,8)}.${format}"`);
  res.sendFile(target);
});

const dist = path.join(root, 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get('*', (req, res) => res.sendFile(path.join(dist, 'index.html')));
}

app.listen(port, '127.0.0.1', () => {
  console.log(`API ISO Studio: http://127.0.0.1:${port}`);
  console.log(webhookUrl ? 'Webhook n8n configurado (pendiente de prueba real)' : 'Modo vista previa: configura N8N_CHAT_URL en .env para conectar n8n');
});
