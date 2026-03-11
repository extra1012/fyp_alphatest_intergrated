require('dotenv').config();
const express = require('express');
const Busboy = require('busboy');
const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const admin = require('firebase-admin');
const { initializeApp } = require('firebase/app');
const { getStorage, ref, uploadBytes } = require('firebase/storage');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
// Serve frontend from /public so Cloud Run can host the UI directly
app.use(express.static(path.join(__dirname, 'public')));

const OUTPUT_FOLDER = path.join(__dirname, 'generated');
const MAX_SIZE = 16 * 1024 * 1024; // 16MB
const ALLOWED_EXT = new Set(['pdf', 'docx', 'pptx']);
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL;
const FIREBASE_CONFIG = {
  apiKey: process.env.FIREBASE_API_KEY || 'your-api-key',
  authDomain: process.env.FIREBASE_AUTH_DOMAIN || 'your-project.firebaseapp.com',
  projectId: process.env.FIREBASE_PROJECT_ID || 'your-project-id',
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET || 'your-project.appspot.com',
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || 'your-messaging-sender-id',
  appId: process.env.FIREBASE_APP_ID || 'your-app-id',
};

const FALLBACK_BUCKET = FIREBASE_CONFIG.projectId ? `${FIREBASE_CONFIG.projectId}.appspot.com` : null;

let firebaseStorage = null;
let adminStorage = null;
let adminInitialized = false;

function firebaseReady() {
  return Boolean(FIREBASE_CONFIG.apiKey && FIREBASE_CONFIG.appId && FIREBASE_CONFIG.storageBucket && !FIREBASE_CONFIG.apiKey.startsWith('your-'));
}

function ensureStorage() {
  if (firebaseStorage) return firebaseStorage;
  if (!firebaseReady()) return null;
  const fbApp = initializeApp(FIREBASE_CONFIG);
  firebaseStorage = getStorage(fbApp);
  return firebaseStorage;
}

function ensureAdminStorage() {
  if (adminStorage) return adminStorage;
  const bucket = FIREBASE_CONFIG.storageBucket || FALLBACK_BUCKET;
  if (!bucket) return null;

  if (!adminInitialized) {
    try {
      if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        const json = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        admin.initializeApp({ credential: admin.credential.cert(json), storageBucket: bucket });
      } else {
        admin.initializeApp({ credential: admin.credential.applicationDefault(), storageBucket: bucket });
      }
      adminInitialized = true;
    } catch (err) {
      console.warn('Failed to initialize firebase-admin storage', err);
      return null;
    }
  }

  try {
    adminStorage = admin.storage().bucket(bucket);
  } catch (err) {
    console.warn('Failed to acquire admin storage bucket', err);
    adminStorage = null;
  }
  return adminStorage;
}

function sanitizeFilename(name) {
  return (name || 'upload').replace(/[^a-zA-Z0-9_.-]/g, '_');
}

async function uploadToFirebase(file) {
  const safeName = sanitizeFilename(file.originalname || 'upload.bin');
  const objectPath = `uploads/${Date.now()}_${safeName}`;

  try {
    const adminBucket = ensureAdminStorage();
    if (adminBucket) {
      await adminBucket.file(objectPath).save(file.buffer, {
        contentType: file.mimetype || 'application/octet-stream',
        resumable: false,
      });
      return { path: objectPath, bucket: adminBucket.name, name: safeName, via: 'admin' };
    }
  } catch (err) {
    console.warn('Admin upload failed, will try client SDK', err.message || err);
  }

  try {
    const storage = ensureStorage();
    if (!storage) return null;
    const storageRef = ref(storage, objectPath);
    await uploadBytes(storageRef, file.buffer, { contentType: file.mimetype || 'application/octet-stream' });
    return { path: storageRef.fullPath, bucket: storageRef.bucket || FIREBASE_CONFIG.storageBucket || FALLBACK_BUCKET, name: storageRef.name, via: 'client' };
  } catch (err) {
    console.warn('Client upload failed', err.message || err);
    return null;
  }
}

async function deleteFromFirebase(uploadMeta) {
  if (!uploadMeta || !uploadMeta.path) return false;
  try {
    const bucketName = uploadMeta.bucket || FIREBASE_CONFIG.storageBucket || FALLBACK_BUCKET;
    if (!bucketName) return false;
    const bucket = admin.storage().bucket(bucketName);
    await bucket.file(uploadMeta.path).delete({ ignoreNotFound: true });
    return true;
  } catch (err) {
    console.warn('Failed to delete uploaded file', err.message || err);
    return false;
  }
}

function parseMultipartRequest(req) {
  return new Promise((resolve, reject) => {
    const busboy = Busboy({ headers: req.headers, limits: { fileSize: MAX_SIZE, files: 1 } });
    const fields = {};
    let fileMeta = null;
    let fileBuffer = Buffer.alloc(0);
    let rejected = false;

    busboy.on('file', (fieldname, file, info) => {
      if (fileMeta) {
        file.resume();
        return;
      }
      const { filename, mimeType } = info;
      const ext = (filename.split('.').pop() || '').toLowerCase();
      if (!ALLOWED_EXT.has(ext)) {
        rejected = true;
        file.resume();
        busboy.emit('error', new Error('Unsupported file type')); // surface to caller
        return;
      }

      file.on('data', (chunk) => {
        if (rejected) return;
        const nextSize = fileBuffer.length + chunk.length;
        if (nextSize > MAX_SIZE) {
          rejected = true;
          file.resume();
          busboy.emit('error', new Error('File too large'));
          return;
        }
        fileBuffer = Buffer.concat([fileBuffer, chunk]);
      });

      file.on('end', () => {
        if (rejected) return;
        fileMeta = {
          fieldname,
          originalname: filename,
          mimetype: mimeType,
          size: fileBuffer.length,
          buffer: fileBuffer,
        };
      });
    });

    busboy.on('field', (name, val) => {
      fields[name] = val;
    });

    busboy.on('error', (err) => {
      rejected = true;
      reject(err);
    });

    busboy.on('finish', () => {
      if (rejected) return;
      if (!fileMeta) {
        reject(new Error('No file uploaded'));
        return;
      }
      resolve({ fields, file: fileMeta });
    });

    req.pipe(busboy);
  });
}

function normalizeTwoOptionQuestion(q, idx = 0) {
  const opts = Array.isArray(q.options) ? q.options.slice(0, 2) : [];
  while (opts.length < 2) {
    opts.push(opts.length === 0 ? 'A: placeholder' : 'B: placeholder');
  }
  const labeled = opts.map((opt, i) => {
    const prefix = i === 0 ? 'A:' : 'B:';
    return opt?.trim().startsWith(prefix) ? opt : `${prefix} ${opt || ''}`.trim();
  });
  const rawAns = q.answerIndex;
  let answerIndex = 0;
  if (typeof rawAns === 'string') {
    const v = rawAns.trim().toLowerCase();
    if (v === '1' || v === 'b' || v === 'option b' || v === 'option2' || v === 'option 2') answerIndex = 1;
  } else {
    const ansNum = Number(rawAns);
    if (ansNum === 1) answerIndex = 1;
  }
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
    'Summarize the provided document and extract its key points.',
    `Generate exactly ${count} questions based on those key points. Each question must:`,
    '- Be at most 18 words.',
    '- Be unique (no repeated questions).',
    `- Be based on a key idea. If there are fewer than ${count} key ideas, reuse ideas but phrase the questions differently.`,
    `If there are more than ${count} key points, select any ${count} of them.`,
    'Each question must include:',
    '- Exactly 2 concise answer options (plain text, no prefixes).',
    '- One correct answer indicated by answerIndex (0 or 1).',
    '- Variation in which option is correct an do not always put the correct option as answerIndex=0.',
    'avoid generation question that with yes/no answer only.',
    'Do NOT create questions about:',
    '- File types',
    '- File names',
    '- Fonts',
    '- Languages used',
    '- Formatting',
    '- Any document metadata',
    'Return ONLY valid JSON in this exact structure:',
    '{',
    '  "questions": [',
    '    {',
    '      "id": "q-1",',
    '      "question": "...",',
    '      "options": ["...", "..."],',
    '      "answerIndex": 0 or 1',
    '    }',
    '  ]',
    '}',
    'After producing the JSON, silently review your output to ensure every rule is followed. If any rule is violated, regenerate the JSON so the final output is fully compliant.',
    `Preset prompt:\n${prompt || 'document only'}.`,
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

async function cleanupUpload(uploadMeta) {
  if (!uploadMeta) return null;
  try {
    return { deleted: await deleteFromFirebase(uploadMeta) };
  } catch (err) {
    console.warn('Cleanup delete failed', err.message || err);
    return { deleted: false, error: err.message || String(err) };
  }
}

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/generator', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'generator.html'));
});

app.post('/generate-game', async (req, res) => {
  try {
    const { file, fields } = await parseMultipartRequest(req);
    const questionNumbers = Number(fields.question_numbers || 10);
    let uploadMeta = null;
    try {
      uploadMeta = await uploadToFirebase(file);
    } catch (err) {
      console.warn('Firebase upload failed, continuing without cloud copy', err);
    }

    const result = generateQuestionsFromFile(file.buffer, questionNumbers);
    res.json({ message: `Generated ${result.total_question} questions`, result, filename: file.originalname, uploaded: uploadMeta });
  } catch (err) {
    const msg = err.message || '';
    const status = msg.toLowerCase().includes('file') || msg.toLowerCase().includes('upload') ? 400 : 500;
    res.status(status).json({ error: msg || 'Upload failed' });
  }
});

app.post('/api/generate-questions', async (req, res) => {
  console.log('[api] /api/generate-questions start');
  let file;
  let fields;
  try {
    const parsed = await parseMultipartRequest(req);
    file = parsed.file;
    fields = parsed.fields;
    console.log('[api] parsed multipart', { size: file?.size, fields });
  } catch (err) {
    console.warn('[api] multipart parse error', err.message || err);
    const status = err.message.toLowerCase().includes('file') ? 400 : 500;
    return res.status(status).json({ error: err.message || 'Upload failed' });
  }

  const prompt = fields?.prompt || '';
  const count = Number(fields?.count || 10) || 10;
  if (!file) {
    return res.status(400).json({ error: 'Upload a pdf/docx/pptx file to generate questions' });
  }

  let uploadMeta = null;
  try {
    uploadMeta = await uploadToFirebase(file);
    console.log('[api] uploaded to storage', uploadMeta);
  } catch (err) {
    console.warn('Firebase upload failed, continuing without cloud copy', err);
  }

  let docContext = null;
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

  try {
    if (!GEMINI_API_KEY) {
      throw new Error('Gemini API key required');
    }

    const result = await generateQuestionsWithGemini(prompt, count, docContext);
    console.log('[api] gemini success', { count: result?.total_question });
    const cleanup = await cleanupUpload(uploadMeta);
    console.log('[api] cleanup done', cleanup);
    return res.json({
      message: `Generated ${result.total_question} questions`,
      result,
      note: 'live-gemini',
      usedFile: file.originalname,
      uploaded: uploadMeta,
      cleanup,
    });
  } catch (err) {
    console.error('[api] gemini failed, serving fallback', err.message || err);
    const fallback = generateQuestionsFromFile(file.buffer, count);
    const cleanup = await cleanupUpload(uploadMeta);
    console.log('[api] cleanup after fallback', cleanup);
    res.status(200).json({
      message: `Generated ${fallback.total_question} fallback questions`,
      result: fallback,
      note: 'fallback-local',
      usedFile: file.originalname,
      uploaded: uploadMeta,
      cleanup,
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

let firebaseHandler = null;
if (process.env.FIREBASE_CONFIG) {
  try {
    // Optional Firebase Functions export so the same Express app can run on Firebase Hosting rewrites.
    const functions = require('firebase-functions');
    firebaseHandler = functions.https.onRequest(app);
  } catch (err) {
    console.warn('firebase-functions not available; skipping Firebase export');
  }
}

// Only start the server directly when running this file, not when imported (e.g., Netlify Functions)
if (require.main === module) {
  const PORT = process.env.PORT || 5000;
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

module.exports = app;
if (firebaseHandler) {
  module.exports.firebase = firebaseHandler;
  module.exports.api = firebaseHandler;
}
