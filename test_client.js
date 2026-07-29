const fs = require('fs');
const { JSDOM } = require('jsdom');
const html = fs.readFileSync('public/index.html', 'utf8');
const script = fs.readFileSync('public/app.js', 'utf8');
const virtualConsole = new jsdom.VirtualConsole();
virtualConsole.on("jsdomError", (error) => {
  console.error(error.stack, error.detail);
});
virtualConsole.sendTo(console);
const dom = new JSDOM(html, { runScripts: "dangerously", virtualConsole });
dom.window.io = () => { return { on: () => {}, emit: () => {} } }; // mock socket.io
dom.window.Prism = { highlightElement: () => {} };
const scriptEl = dom.window.document.createElement("script");
scriptEl.textContent = script;
dom.window.document.body.appendChild(scriptEl);
const event = dom.window.document.createEvent('Event');
event.initEvent('DOMContentLoaded', true, true);
dom.window.document.dispatchEvent(event);
console.log('Script loaded successfully.');
