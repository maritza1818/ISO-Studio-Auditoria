# ISO Studio 2.0 — Artefactos y diagramas

Proyecto React/Vite + Express para Windows; extiende el frontend original de ISO Studio sin modificar n8n, Qdrant ni Gemini.

## Novedades

- Nuevo apartado **Herramientas y archivos** con ejemplos de uso.
- Diagramas Mermaid **renderizados** en las respuestas (SVG / PNG descargables).
- **PDF** y **DOCX** verdaderos a partir de Markdown, con títulos, tablas, párrafos, listas e imágenes de Mermaid cuando se pueden rasterizar.
- Descargas como fichas adjuntas a los mensajes del agente; generación automática si el usuario pide crear/exportar PDF o Word.
- Nuevo endpoint local `POST /api/artifacts` y `GET /api/artifacts/:id/:format`.
- Nueva Skill importable `skills/Skill_Artefactos_ISO_Studio.json`, diseñada para enseñar al agente el protocolo de salida sin reemplazar la Skill ISO original.

## Instalación

Lee **INSTALAR_EN_WINDOWS.md**. Resumen:

```powershell
cd 'C:\Auditoria Agente\iso-studio-2'
npm install
Copy-Item .env.example .env
# Edita .env con tu Chat URL de n8n local
npm run dev
```

React: http://localhost:5173  ·  API local: http://127.0.0.1:4317

## Seguridad y límites

El backend se enlaza a `127.0.0.1`, rechaza formatos que no sean PDF/DOCX y guarda artefactos bajo identificadores generados por el servidor. No ejecuta código de los mensajes. Mermaid usa nivel de seguridad estricto y sanitización SVG. El servicio guarda las descargas solo localmente, las limpia pasadas 48 horas al reiniciar y no incluye un sistema multiusuario.

**No** se incluye el documento ISO/IEC 27701 ni API keys. No se prometen funciones no implementadas (OCR, edición de archivos subidos, acceso al sistema de archivos ajeno al proyecto, generación de imágenes IA, navegación autónoma, etc.).

## Pruebas disponibles

`npm run test:parsers` valida Markdown/tables/diagramas y nombres de archivo; la integración n8n, React y el render real del PDF/DOCX debe probarse en tu Windows tras `npm install`.
