# livecode

> Real-time collaborative code editor with WebRTC voice communication, Pyodide in-browser Python execution, interactive terminal, and proctoring controls.

<img width="1912" height="930" alt="livecode" src="https://github.com/user-attachments/assets/618877c5-04eb-43eb-bdfa-424c00503c6e" />

## Features

- **Real-time Collaboration**: Live code sync, cursor tracking, and presence via Socket.IO.
- **In-Browser Python Execution**: Client-side execution powered by Pyodide (WebAssembly).
- **Audio & Chat**: WebRTC voice communication and built-in chat drawer.
- **Interactive Terminal**: Integrated terminal powered by xterm.js.
- **Editor Controls**: Multi-tab editing, syntax highlighting (Prism), read-only mode, and anti-cheat exam safeguards.

## Prerequisites

- [Node.js](https://nodejs.org/) (v18 or higher recommended)
- npm (v9 or higher)

## Getting Started

1. **Clone the repository:**
   ```bash
   git clone https://github.com/<your-username>/livecode.git
   cd livecode
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Start the server:**
   ```bash
   npm start
   ```

4. **Open in browser:**
   Navigate to [http://localhost:3000](http://localhost:3000).

## Environment Variables

Copy `.env.example` to `.env` (optional):
```bash
PORT=3000
```

## License

This project is licensed under the [MIT License](LICENSE).
