# GAiN-Study GO

GAiN-Study GO is an interactive study game built for a final year project. It turns uploaded learning material into a two-option quiz and lets players answer by driving a car through the correct lane.

Live site: https://quiz-api-719289943539.asia-southeast1.run.app/

## What it does

- Upload a study document in `pdf`, `docx`, or `pptx` format.
- Generate quiz questions from the uploaded content.
- Review the generated questions and choose which ones to play.
- Start the run and answer by steering left or right.
- View your score at the end and open the feedback survey.

## How to play

### 1. Prepare and upload

1. Choose a file in `pdf`, `docx`, or `pptx` format.
2. Select how many questions you want.
3. Click **Generate quiz**.

The app uploads the file, extracts text, and generates questions from it. Uploaded files are processed automatically and then deleted after processing. If the upload takes a while, wait a moment and try again if you receive a temporary error.

### 2. Pick questions

1. Review the generated list.
2. Select the questions you want to include.
3. Click **Start game**.

### 3. Play the run

- On desktop, use `A` for left and `D` for right.
- On touch devices, move your finger left and right to steer.
- Answer each question by moving into the correct option lane.

### 4. Finish the game

- When the run ends, your score is shown on screen.
- Use **Open survey** to provide feedback.

## Features

- Document-to-quiz generation using uploaded study material.
- Two-option questions designed for quick in-game responses.
- Question selection before the run starts.
- Keyboard and touch controls.
- End-of-run score screen with replay and survey options.
- Web UI served directly from the Node.js app.

## Project structure

- `server.js` - Express server, upload handling, question generation, and API routes.
- `public/` - Frontend files served to the browser.
- `app.js` - Game logic and Babylon.js scene setup.
- `gate.js` - Track gate rendering helpers.
- `crowdManager.js` - Crowd and scene support logic.
- `quizManager.js` - Quiz selection and question handling.
- `README.md` - Project documentation.

## Running locally

### Prerequisites

- Node.js 18 or newer.
- A Google Gemini API key if you want live AI question generation.

### Install

```bash
npm install
```

### Configure environment

Create a `.env` file in the project root if you want to use Gemini generation:

```bash
GEMINI_API_KEY=your_api_key_here
GEMINI_MODEL=your_model_name_here
PORT=5000
```

### Start the app

```bash
npm start
```

Open `http://localhost:5000` in your browser.

## API routes

- `GET /` - Main game page.
- `GET /generator` - Generator page.
- `POST /api/generate-questions` - Upload a document and generate questions.
- `POST /save-questions` - Save selected questions to the output folder.
- `GET /api/questions/latest` - Load the latest saved question set.

## Notes

- Supported uploads are limited to `pdf`, `docx`, and `pptx`.
- The app falls back to local placeholder questions if extraction or Gemini generation fails.
- Selected questions can be stored in the generated output folder when persistence is enabled.
