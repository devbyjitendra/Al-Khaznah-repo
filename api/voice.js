const SYSTEM_INSTRUCTION = `You are Al Khaznah AI, an intelligent, versatile, helpful, and friendly conversational AI assistant, designed to converse naturally and assist with any topic just like ChatGPT.

GUIDELINES:
1. RESPONSE STYLE: Provide direct, well-structured, clear, and comprehensive answers. Adjust depth and explanation based on the user's inquiry.
2. CODING & TECHNICAL: When writing code, provide clean, idiomatic, and well-explained solutions with appropriate code blocks.
3. CONVERSATIONAL & ADAPTIVE: Be helpful, polite, insightful, and easy to understand.
4. CLEAN FORMATTING: Use clean markdown (headings, bullet points, code blocks). Do NOT use raw LaTeX dollar delimiters ($ or $$); format formulas using standard readable notation like O(log n), x^2, etc.`;

export const config = {
  runtime: 'nodejs',
  api: {
    bodyParser: {
      sizeLimit: '10mb'
    }
  }
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { base64Audio, mimeType = 'audio/wav', config: userConfig } = req.body || {};

  if (!base64Audio) {
    return res.status(400).json({ error: 'Audio data is required' });
  }

  const geminiApiKey = (userConfig?.geminiApiKey || process.env.GEMINI_API_KEY || '').trim();

  // Set SSE Headers for real-time token streaming
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive'
  });

  const sendMeta = (question) => {
    res.write(`data: ${JSON.stringify({ question })}\n\n`);
  };

  const sendChunk = (text) => {
    res.write(`data: ${JSON.stringify({ chunk: text })}\n\n`);
  };

  const sendEnd = () => {
    res.write('data: [DONE]\n\n');
    res.end();
  };

  if (!geminiApiKey) {
    sendChunk('No Google Gemini API Key configured for voice queries. Please add it in Settings ⚙ or set GEMINI_API_KEY on Vercel.');
    return sendEnd();
  }

  const preferredModel = userConfig?.geminiModel || 'gemini-2.5-flash';
  const modelsToTry = [preferredModel, 'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'];
  const uniqueModels = [...new Set(modelsToTry)];

  let success = false;

  for (const m of uniqueModels) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:streamGenerateContent?alt=sse&key=${geminiApiKey}`;

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
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
            temperature: 0.2,
            maxOutputTokens: 1200
          }
        })
      });

      if (!response.ok) {
        const errText = await response.text();
        console.warn(`Voice model ${m} failed:`, errText);
        continue;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let accumulated = '';
      let hasStarted = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
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
                  sendMeta(questionText);

                  const firstAnswerPart = parts[1] || '';
                  if (firstAnswerPart) {
                    sendChunk(firstAnswerPart);
                  }
                } else if (hasStarted) {
                  sendChunk(textChunk);
                }
              }
            } catch (e) {}
          }
        }
      }

      if (!hasStarted && accumulated) {
        const raw = accumulated.replace(/\[QUESTION\]:[^\n]*/gi, '').replace(/\[ANSWER\]:/gi, '').trim();
        if (raw) {
          sendMeta('Voice Question');
          sendChunk(raw);
        }
      }

      success = true;
      break;
    } catch (err) {
      console.warn(`Voice attempt with ${m} failed:`, err.message);
    }
  }

  if (!success) {
    sendChunk('Could not process voice audio. Please check your microphone recording and Gemini API configuration.');
  }

  return sendEnd();
}
