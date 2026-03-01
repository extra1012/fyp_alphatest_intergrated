require('dotenv').config();
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(__dirname));

const OUTPUT_FOLDER = path.join(__dirname, 'generated');
const MAX_SIZE = 16 * 1024 * 1024; // 16MB
const ALLOWED_EXT = new Set(['pdf', 'docx', 'pptx']);
const GEMINI_API_KEY = process.env.GEMINI_API_KEY ;
const GEMINI_MODEL = process.env.GEMINI_MODEL ;

const storage = multer.memoryStorage();

const upload = multer({
  storage,
  limits: { fileSize: MAX_SIZE },
  fileFilter: (_req, file, cb) => {
    const ext = (file.originalname.split('.').pop() || '').toLowerCase();
    cb(null, ALLOWED_EXT.has(ext));
  },
});

function normalizeTwoOptionQuestion(q, idx = 0) {
  const opts = Array.isArray(q.options) ? q.options.slice(0, 2) : [];
  while (opts.length < 2) {
    opts.push(opts.length === 0 ? 'A: placeholder' : 'B: placeholder');
  }
  const labeled = opts.map((opt, i) => {
    const prefix = i === 0 ? 'A:' : 'B:';
    return opt?.trim().startsWith(prefix) ? opt : `${prefix} ${opt || ''}`.trim();
  });
  const answerIndex = q.answerIndex === 1 ? 1 : 0;
  return {
    id: q.id || `q-${idx + 1}`,
    question_number: q.question_number || idx + 1,
    question: q.question || '',
    options: labeled,
    answerIndex,
  };
}

function extractJsonObject(text) {
  if (!text || typeof text !== 'string') throw new Error('Empty response text');
  const fenced = text.match(/```json\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const braceMatch = candidate.match(/\{[\s\S]*\}/);
  const payload = braceMatch ? braceMatch[0] : candidate;
  return JSON.parse(payload);
}

// Placeholder generator; replace with real parsing/LLM logic if needed
function generateQuestionsFromFile(_fileBuffer, count = 10) {
  return {
    total_question: count,
    questions: Array.from({ length: count }).map((_, i) =>
      normalizeTwoOptionQuestion(
        {
          id: `q-${i + 1}`,
          question_number: i + 1,
          question: `Sample question ${i + 1}?`,
          options: ['A: Sample correct', 'B: Sample wrong'],
          answerIndex: 0,
        },
        i
      )
    ),
  };
}

function storeSelectedQuestions(resultData, selectedNumbers, sourceFilename) {
  if (!OUTPUT_FOLDER || !fs.existsSync(OUTPUT_FOLDER)) {
    return null;
  }
  const set = new Set(selectedNumbers.map(Number));
  const filtered = (resultData.questions || []).filter((q) => set.has(Number(q.question_number ?? -1)));
  const out = { total_question: filtered.length, questions: filtered };
  const base = (sourceFilename || 'questions').replace(/[^a-zA-Z0-9_.-]/g, '_');
  const outName = `${base}_${Date.now()}.json`;
  const outPath = path.join(OUTPUT_FOLDER, outName);
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf-8');
  return outPath;
}

async function generateQuestionsWithGemini(prompt, count = 10, docContext = null) {
  if (!GEMINI_API_KEY) {
    throw new Error('Missing GEMINI_API_KEY');
  }

  const systemPrompt = [
    `Summarize the provided document, find key points, and create ${count} questions within 18 words (no duplicates question).`,
    `If there are more than ${count} key points, randomly pick ${count}; otherwise keep all points but still output ${count} questions (repeat key ideas if needed without duplication).`,
    'Each question must have exactly 2 concise options (plain text, no A:/B: prefixes) and one correct answer.',
    'Return strict JSON only, no prose:',
    '{"questions":[{"id":"q-1","question":"...","options":["option text 1","option text 2"],"answerIndex":0}]}',
    'answerIndex must be 0 for the first option or 1 for the second; the game will label gates as A/B.',
    `Preset prompt:
${prompt || 'document only'}.`,
    docContext
      ? [
          'Document context (base64, truncated to ~4k chars):',
          `Filename: ${docContext.filename}`,
          `MIME: ${docContext.mimetype}`,
          docContext.base64,
        ].join('\n')
      : 'No document provided; do not generate.',
  ].join('\n');
  // Attempt with SDK only; if it fails, let the caller serve fallback without extra network calls
  let parsed;
  try {
    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });
    const result = await model.generateContent({
      contents: [
        {
          role: 'user',
          parts: [{ text: systemPrompt }],
        },
      ],
      generationConfig: {
        temperature: 0.6,
      },
    });
    const text = result?.response?.text?.() || '';
    //console.log('Gemini SDK raw response:', text); // test line
    parsed = extractJsonObject(text);
  } catch (sdkErr) {
    throw new Error(`Gemini SDK error: ${sdkErr.message}`);
  }

  const normalized = Array.isArray(parsed.questions) ? parsed.questions : [];
  const mapped = normalized.map((q, idx) => normalizeTwoOptionQuestion(q, idx));
  const seen = new Set();
  const deduped = [];
  for (const q of mapped) {
    const key = (q.question || '').trim().toLowerCase();
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    deduped.push(q);
  }
  const capped = deduped.slice(0, count);
  while (capped.length < count) {
    const i = capped.length;
    capped.push(
      normalizeTwoOptionQuestion(
        {
          id: `q-${i + 1}`,
          question_number: i + 1,
          question: `Placeholder question ${i + 1}`,
          options: ['A: Placeholder', 'B: Placeholder'],
          answerIndex: 0,
        },
        i
      )
    );
  }
  const reindexed = capped.map((q, i) => ({ ...q, question_number: i + 1, id: q.id || `q-${i + 1}` }));
  return {
    total_question: reindexed.length,
    questions: reindexed,
  };
}

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/generator', (_req, res) => {
  res.sendFile(path.join(__dirname, 'generator.html'));
});

app.post('/generate-game', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const questionNumbers = Number(req.body.question_numbers || 10);
  try {
    const result = generateQuestionsFromFile(req.file.buffer, questionNumbers);
    res.json({ message: `Generated ${result.total_question} questions`, result, filename: req.file.filename });
  } catch (err) {
    res.status(500).json({ error: `Processing failed: ${err.message}` });
  }
});

app.post('/api/generate-questions', upload.single('file'), async (req, res) => {
  const { prompt = '', count = 10 } = req.body || {};
  const file = req.file;
  if (!file) {
    return res.status(400).json({ error: 'Upload a pdf/docx/pptx file to generate questions' });
  }
  /*console.log('generate-questions input:', {
    prompt,
    count,
    filename: file.originalname,
    mimetype: file.mimetype,
    size: file.size,
  });
  // test line 
  */
  let docContext = null;

  if (file) {
    try {
      const base64 = file.buffer.toString('base64').slice(0, 4000); // truncate to keep payload small
      docContext = {
        filename: file.originalname,
        mimetype: file.mimetype,
        base64,
      };
    } catch (err) {
      console.warn('Failed to read uploaded file for Gemini prompt:', err);
    }
  }

  try {
    if (!GEMINI_API_KEY) {
      throw new Error('Gemini API key required');
    }

    const result = await generateQuestionsWithGemini(prompt, Number(count) || 10, docContext);
    res.json({
      message: `Generated ${result.total_question} questions`,
      result,
      note: 'live-gemini',
      usedFile: file ? file.originalname : null,
    });
  } catch (err) {
    console.error('Gemini generation failed, serving fallback', err);
    const fallback = generateQuestionsFromFile(file.buffer, Number(count) || 10);
    res.status(200).json({
      message: `Generated ${fallback.total_question} fallback questions`,
      result: fallback,
      note: 'fallback-local',
      usedFile: file ? file.originalname : null,
      warning: `Gemini generation failed: ${err.message}`,
    });
  }
});

app.post('/save-questions', (req, res) => {
  const { result_json, source_filename = 'questions.json' } = req.body;
  const selected = Array.isArray(req.body.selected) ? req.body.selected : [];
  if (!result_json) return res.status(400).json({ error: 'No result payload provided' });
  if (!selected.length) return res.status(200).json({ message: 'No questions selected' });

  try {
    const parsed = typeof result_json === 'string' ? JSON.parse(result_json) : result_json;
    const savedPath = storeSelectedQuestions(parsed, selected, source_filename);
    const gid = Number(Date.now());
    res.json({ message: savedPath ? 'Saved' : 'Saving skipped (persistence disabled)', gid, savedPath, selected: selected.map(Number) });
  } catch (err) {
    res.status(500).json({ error: `Save failed: ${err.message}` });
  }
});

app.get('/api/questions/latest', (_req, res) => {
  if (!OUTPUT_FOLDER || !fs.existsSync(OUTPUT_FOLDER)) {
    return res.status(404).json({ error: 'no questions available' });
  }
  const files = fs.readdirSync(OUTPUT_FOLDER).filter((f) => f.endsWith('.json')).sort().reverse();
  if (!files.length) return res.status(404).json({ error: 'no questions available' });
  const data = JSON.parse(fs.readFileSync(path.join(OUTPUT_FOLDER, files[0]), 'utf-8'));
  const normalized = (data.questions || []).map((q, idx) =>
    normalizeTwoOptionQuestion(
      {
        ...q,
        question: q.question || q.question_text || '',
        options: q.options || q.choices || [],
      },
      idx
    )
  );
  res.json({ questions: normalized });
});

// Only start the server directly when running this file, not when imported (e.g., Netlify Functions)
if (require.main === module) {
  const PORT = process.env.PORT || 5000;
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

module.exports = app;
