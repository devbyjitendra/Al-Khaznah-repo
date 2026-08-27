require('dotenv').config();
const { app, BrowserWindow, ipcMain, screen, nativeImage, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const OpenAI = require('openai');
const axios = require('axios');

// Persistent HTTP Keep-Alive connection pool for instant sub-second round-trips
const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 20,
  maxFreeSockets: 10,
  timeout: 30000,
  keepAliveMsecs: 60000
});

const apiClient = axios.create({
  httpsAgent: httpsAgent,
  timeout: 25000
});

// Global state
let mainWindow = null;
let currentTranscript = '';

const isWindows = process.platform === 'win32';

// Config store path
const configPath = path.join(app.getPath('userData'), 'angel-config.json');

function loadConfig() {
  const geminiEnv = (process.env.GEMINI_API_KEY || '').trim();
  const openaiEnv = (process.env.OPENAI_API_KEY || '').trim();

  const defaults = {
    provider: geminiEnv ? 'gemini' : (openaiEnv ? 'openai' : 'gemini'),
    openaiApiKey: openaiEnv,
    openaiModel: 'gpt-4o-mini',
    geminiApiKey: geminiEnv,
    geminiModel: 'gemini-3.5-flash-lite'
  };

  try {
    if (fs.existsSync(configPath)) {
      const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (!saved.geminiModel || saved.geminiModel.includes('1.5') || saved.geminiModel.includes('2.5') || saved.geminiModel.includes('2.0') || saved.geminiModel.includes('3.6')) {
        saved.geminiModel = 'gemini-3.5-flash-lite';
      }
      return { 
        ...defaults, 
        ...saved,
        geminiApiKey: saved.geminiApiKey || geminiEnv,
        openaiApiKey: saved.openaiApiKey || openaiEnv
      };
    }
  } catch (err) {
    console.error('Error reading config file:', err);
  }
  return defaults;
}

let appConfig = loadConfig();

function saveConfig(newConfig) {
  if (newConfig.geminiModel && (newConfig.geminiModel.includes('1.5') || newConfig.geminiModel.includes('2.5') || newConfig.geminiModel.includes('2.0') || newConfig.geminiModel.includes('3.6'))) {
    newConfig.geminiModel = 'gemini-3.5-flash-lite';
  }
  appConfig = { ...appConfig, ...newConfig };
  try {
    fs.writeFileSync(configPath, JSON.stringify(appConfig, null, 2), 'utf8');
  } catch (err) {
    console.error('Error saving config file:', err);
  }
}

function getOpenAIClient() {
  const apiKey = (appConfig.openaiApiKey || process.env.OPENAI_API_KEY || '').trim();
  if (!apiKey) return null;
  return new OpenAI({
    apiKey: apiKey,
    maxRetries: 2,
    timeout: 25000
  });
}

function createWindow() {
  const iconPath = path.join(__dirname, 'assets/icons/logo.png');
  const appIcon = nativeImage.createFromPath(iconPath);

  const windowOptions = {
    width: 560,
    height: 720,
    minWidth: 440,
    minHeight: 520,
    alwaysOnTop: true,
    transparent: false,
    frame: true,
    skipTaskbar: false,
    icon: appIcon,
    backgroundColor: '#090d16',
    titleBarStyle: 'default',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false
    }
  };

  Menu.setApplicationMenu(null);

  mainWindow = new BrowserWindow(windowOptions);
  mainWindow.setIcon(appIcon);
  mainWindow.loadFile('index.html');

  if (process.platform === 'darwin') {
    mainWindow.once('ready-to-show', () => {
      mainWindow.show();
      mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      app.dock.show();
      mainWindow.moveTop();
    });
  } else if (isWindows) {
    mainWindow.setSkipTaskbar(false);
    app.setAppUserModelId('com.lazyjobseeker.angel');
  }

  console.log('Main window created successfully');
}

const SYSTEM_INSTRUCTION = `You are Al Khaznah AI, an intelligent, versatile, helpful, and friendly conversational AI assistant, designed to converse naturally and assist with any topic just like ChatGPT.

GUIDELINES:
1. RESPONSE STYLE: Provide direct, well-structured, clear, and comprehensive answers. Adjust depth and explanation based on the user's inquiry.
2. CODING & TECHNICAL: When writing code, provide clean, idiomatic, and well-explained solutions with appropriate code blocks.
3. CONVERSATIONAL & ADAPTIVE: Be helpful, polite, insightful, and easy to understand.
4. CLEAN FORMATTING: Use clean markdown (headings, bullet points, code blocks). Do NOT use raw LaTeX dollar delimiters ($ or $$); format formulas using standard readable notation like O(log n), x^2, etc.`;

// Ultra-Fast Streaming Answer Generator for Text Queries
async function streamAnswer(prompt, userQuestion = null) {
  if (!prompt || !prompt.trim()) return;

  const questionTitle = userQuestion || prompt;

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('stream-start', { question: questionTitle });
  }

  const provider = appConfig.provider || 'gemini';

  // 1. Gemini Streaming with Hot Socket Keep-Alive
  if (provider === 'gemini') {
    const apiKey = (appConfig.geminiApiKey || process.env.GEMINI_API_KEY || '').trim();
    if (!apiKey) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('stream-chunk', 'No Google Gemini API Key configured. Please add it in Settings ⚙.');
        mainWindow.webContents.send('stream-end');
      }
      return;
    }

    const preferredModel = appConfig.geminiModel || 'gemini-3.5-flash-lite';
    const modelsToTry = [preferredModel, 'gemini-3.5-flash-lite', 'gemini-3.7-flash', 'gemini-flash-latest'];
    const uniqueModels = [...new Set(modelsToTry)];

    for (const m of uniqueModels) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:streamGenerateContent?alt=sse&key=${apiKey}`;

        const response = await apiClient.post(url, {
          contents: [
            {
              role: 'user',
              parts: [
                {
                  text: `${SYSTEM_INSTRUCTION}\n\nQuestion: "${prompt}"\n\nProvide a human-like, clear, and brief answer:`
                }
              ]
            }
          ],
          generationConfig: {
            temperature: 0.15,
            maxOutputTokens: 900
          }
        }, { responseType: 'stream' });

        let buffer = '';

        response.data.on('data', (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop();

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const jsonStr = line.replace('data: ', '').trim();
              if (!jsonStr || jsonStr === '[DONE]') continue;
              try {
                const parsed = JSON.parse(jsonStr);
                const textChunk = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
                if (textChunk && mainWindow && !mainWindow.isDestroyed()) {
                  mainWindow.webContents.send('stream-chunk', textChunk);
                }
              } catch (e) {}
            }
          }
        });

        response.data.on('end', () => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('stream-end');
          }
        });

        return;
      } catch (err) {
        console.warn(`Streaming with ${m} failed:`, err.response?.data?.error?.message || err.message);
      }
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('stream-chunk', 'Failed to connect to Gemini. Check your network or API key.');
      mainWindow.webContents.send('stream-end');
    }
    return;
  }

  // 2. OpenAI Streaming
  if (provider === 'openai') {
    const openai = getOpenAIClient();
    if (!openai) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('stream-chunk', 'No OpenAI API Key configured. Please add it in Settings ⚙.');
        mainWindow.webContents.send('stream-end');
      }
      return;
    }

    try {
      const model = appConfig.openaiModel || 'gpt-4o-mini';
      const stream = await openai.chat.completions.create({
        model: model,
        messages: [
          {
            role: 'system',
            content: SYSTEM_INSTRUCTION
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.15,
        max_tokens: 900,
        stream: true
      });

      for await (const chunk of stream) {
        const content = chunk.choices[0]?.delta?.content || '';
        if (content && mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('stream-chunk', content);
        }
      }

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('stream-end');
      }
    } catch (err) {
      console.error('OpenAI Stream Error:', err.message);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('stream-chunk', `OpenAI Error: ${err.message}`);
        mainWindow.webContents.send('stream-end');
      }
    }
  }
}

// Single-Pass Audio Transcribe + Human-like Candidate Answer Generator
async function processSpeechAudio(base64Audio, mimeType = 'audio/wav') {
  if (!base64Audio || base64Audio.length < 200) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('answer', 'Please hold the mic or press Space and speak your question.');
    }
    return;
  }

  const apiKey = (appConfig.geminiApiKey || process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('answer', 'Please configure your Gemini API Key in Settings ⚙.');
    }
    return;
  }

  const preferredModel = appConfig.geminiModel || 'gemini-3.5-flash-lite';
  const modelsToTry = [preferredModel, 'gemini-3.5-flash-lite', 'gemini-3.7-flash', 'gemini-flash-latest'];
  const uniqueModels = [...new Set(modelsToTry)];

  for (const m of uniqueModels) {
    try {
      console.log(`Processing voice stream with ${m} (size: ${base64Audio.length})...`);
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:streamGenerateContent?alt=sse&key=${apiKey}`;

      const response = await apiClient.post(url, {
        contents: [
          {
            role: 'user',
            parts: [
              {
                inlineData: {
                  mimeType: mimeType,
                  data: base64Audio
                }
              },
              {
                text: `${SYSTEM_INSTRUCTION}
TASK INSTRUCTIONS:
1. Listen to the audio clip.
2. Output EXACTLY two sections formatted as follows:
[QUESTION]: <Exact question or prompt spoken by the user>
[ANSWER]: <Helpful, clear, and comprehensive answer to the user's inquiry>`
              }
            ]
          }
        ],
        generationConfig: {
          temperature: 0.15,
          maxOutputTokens: 950
        }
      }, { responseType: 'stream' });

      let accumulated = '';
      let hasStarted = false;
      let buffer = '';

      response.data.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const jsonStr = line.replace('data: ', '').trim();
            if (!jsonStr || jsonStr === '[DONE]') continue;
            try {
              const parsed = JSON.parse(jsonStr);
              const textChunk = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
              if (textChunk) {
                accumulated += textChunk;

                if (!hasStarted && accumulated.includes('[ANSWER]:')) {
                  hasStarted = true;
                  const parts = accumulated.split(/\[ANSWER\]:\s*/i);
                  const qMatch = parts[0].match(/\[QUESTION\]:\s*([^\n\r]+)/i);
                  const questionText = qMatch ? qMatch[1].trim() : 'Voice Question';

                  if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('stream-start', { question: `🎤 ${questionText}` });
                    const firstAnswerPart = parts[1] || '';
                    if (firstAnswerPart) {
                      mainWindow.webContents.send('stream-chunk', firstAnswerPart);
                    }
                  }
                } else if (hasStarted) {
                  if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('stream-chunk', textChunk);
                  }
                }
              }
            } catch (e) {}
          }
        }
      });

      response.data.on('end', () => {
        if (hasStarted && mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('stream-end');
        } else if (!hasStarted) {
          // Fallback if [ANSWER] tag was omitted by model
          const raw = accumulated.replace(/\[QUESTION\]:[^\n]*/gi, '').replace(/\[ANSWER\]:/gi, '').trim();
          if (raw && mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('stream-start', { question: '🎤 Voice Question' });
            mainWindow.webContents.send('stream-chunk', raw);
            mainWindow.webContents.send('stream-end');
          } else if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('answer', 'Could not hear clear audio. Please speak into your microphone and try again.');
          }
        }
      });

      return;
    } catch (err) {
      console.warn(`Audio streaming with ${m} failed:`, err.response?.data?.error?.message || err.message);
    }
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('answer', 'Could not connect to microphone AI service. Please try again.');
  }
}

// IPC Handlers
ipcMain.on('get-config', (event) => {
  event.returnValue = appConfig;
});

ipcMain.on('save-config', (event, newConfig) => {
  saveConfig(newConfig);
  event.reply('config-saved', appConfig);
});

// Stream typed question
ipcMain.on('stream-question', async (event, question) => {
  currentTranscript = question;
  await streamAnswer(question);
});

// Voice recording complete
ipcMain.on('audio-chunk-complete', async (event, { base64Audio, mimeType }) => {
  await processSpeechAudio(base64Audio, mimeType || 'audio/wav');
});

ipcMain.on('reset-transcript', () => {
  currentTranscript = '';
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('transcript', '');
  }
});

// App lifecycle
app.whenReady().then(() => {
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled Rejection:', err);
});