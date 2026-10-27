import mermaid from 'mermaid';
mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral', suppressErrorRendering: true });
let sequence = 0;
window.renderNoteDiagram = async source => (await mermaid.render(`note-diagram-${++sequence}`, source)).svg;
