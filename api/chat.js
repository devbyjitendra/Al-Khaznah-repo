const SYSTEM_INSTRUCTION = `You are Al Khaznah AI, an intelligent, versatile, helpful, and friendly conversational AI assistant, designed to converse naturally and assist with any topic just like ChatGPT.

GUIDELINES:
1. RESPONSE STYLE: Provide direct, well-structured, clear, and comprehensive answers. Adjust depth and explanation based on the user's inquiry.
2. CODING & TECHNICAL: When writing code, provide clean, idiomatic, and well-explained solutions with appropriate code blocks.
3. CONVERSATIONAL & ADAPTIVE: Be helpful, polite, insightful, and easy to understand.
4. CLEAN FORMATTING: Use clean markdown (headings, bullet points, code blocks). Do NOT use raw LaTeX dollar delimiters ($ or $$); format formulas using standard readable notation like O(log n), x^2, etc.`;

export const config = {
  runtime: 'nodejs'
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { prompt, config: userConfig } = req.body || {};

  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: 'Prompt is required' });
  }

  const provider = userConfig?.provider || 'gemini';
  const geminiApiKey = (userConfig?.geminiApiKey || process.env.GEMINI_API_KEY || '').trim();
  const openaiApiKey = (userConfig?.openaiApiKey || process.env.OPENAI_API_KEY || '').trim();

  // Set SSE Headers for real-time token streaming
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive'
  });

  const sendChunk = (text) => {
    res.write(`data: ${JSON.stringify({ chunk: text })}\n\n`);
  };

  const sendEnd = () => {
    res.write('data: [DONE]\n\n');
    res.end();
  };

  if (provider === 'gemini') {
    if (!geminiApiKey) {
      sendChunk('No Google Gemini API Key provided. Please configure it in Settings ⚙ or set GEMINI_API_KEY in Vercel environment variables.');
      return sendEnd();
    }

    const preferredModel = userConfig?.geminiModel || 'gemini-1.5-flash';
    const modelsToTry = [preferredModel, 'gemini-1.5-flash', 'gemini-1.5-flash-latest', 'gemini-1.5-pro', 'gemini-2.0-flash'];
    const uniqueModels = [...new Set(modelsToTry)];

    let success = false;
    let lastErrorMessage = '';
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
                    text: `${SYSTEM_INSTRUCTION}\n\nQuestion: "${prompt}"\n\nProvide a human-like, clear, and comprehensive answer:`
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
          console.warn(`Model ${m} failed:`, errText);
          try {
            const errObj = JSON.parse(errText);
            lastErrorMessage = errObj.error?.message || errText;
          } catch(e) {
            lastErrorMessage = errText;
          }
          continue;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

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
                const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
                if (text) {
                  sendChunk(text);
                }
              } catch (e) {}
            }
          }
        }

        success = true;
        break;
      } catch (err) {
        lastErrorMessage = err.message;
        console.warn(`Attempt with ${m} failed:`, err.message);
      }
    }

    if (!success) {
      sendChunk(`Gemini Error: ${lastErrorMessage || 'Failed to connect. Please check your Gemini API key or quota in Settings ⚙.'}`);
    }
    return sendEnd();
  }

  if (provider === 'openai') {
    if (!openaiApiKey) {
      sendChunk('No OpenAI API Key provided. Please configure it in Settings ⚙ or set OPENAI_API_KEY in Vercel environment variables.');
      return sendEnd();
    }

    try {
      const model = userConfig?.openaiModel || 'gpt-4o-mini';
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${openaiApiKey}`
        },
        body: JSON.stringify({
          model: model,
          messages: [
            { role: 'system', content: SYSTEM_INSTRUCTION },
            { role: 'user', content: prompt }
          ],
          temperature: 0.2,
          max_tokens: 1200,
          stream: true
        })
      });

      if (!response.ok) {
        const errText = await response.text();
        sendChunk(`OpenAI Error: ${errText}`);
        return sendEnd();
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const jsonStr = line.replace('data: ', '').trim();
            if (jsonStr === '[DONE]') break;
            try {
              const parsed = JSON.parse(jsonStr);
              const text = parsed.choices?.[0]?.delta?.content;
              if (text) {
                sendChunk(text);
              }
            } catch (e) {}
          }
        }
      }
    } catch (err) {
      sendChunk(`OpenAI Request Failed: ${err.message}`);
    }
    return sendEnd();
  }

  sendChunk('Unknown provider requested.');
  sendEnd();
}
