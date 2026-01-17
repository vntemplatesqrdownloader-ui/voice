import express from "express";
import cors from "cors";
import multer from "multer";
import fetch from "node-fetch";

import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { TranscribeClient, StartTranscriptionJobCommand, GetTranscriptionJobCommand } from "@aws-sdk/client-transcribe";

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage() });

/**
 * ENV REQUIRED (Render में डालेंगे)
 * AWS_ACCESS_KEY_ID
 * AWS_SECRET_ACCESS_KEY
 * AWS_REGION
 * S3_BUCKET
 */

const AWS_REGION = process.env.AWS_REGION || "ap-south-1";
const S3_BUCKET = process.env.S3_BUCKET;

if (!S3_BUCKET) {
  console.log("❌ Missing env S3_BUCKET");
}

const s3 = new S3Client({
  region: AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
  },
});

const transcribe = new TranscribeClient({
  region: AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
  },
});

// Health check
app.get("/", (req, res) => {
  res.json({ ok: true, service: "Bharat STT Backend", region: AWS_REGION });
});

/**
 * POST /api/stt
 * multipart/form-data
 * field: audio
 * optional: language (hi-IN / en-IN)
 */
app.post("/api/stt", upload.single("audio"), async (req, res) => {
  try {
    const file = req.file;
    const language = req.body.language || "hi-IN";

    if (!file) {
      return res.status(400).json({ ok: false, error: "audio file is required" });
    }

    // AWS Transcribe supported language codes:
    // hi-IN, en-IN etc.
    const jobId = `bharat_stt_${Date.now()}`;
    const key = `uploads/${jobId}_${file.originalname || "audio.webm"}`;

    console.log("🎤 STT request:", { jobId, language, size: file.size });

    // 1) Upload to S3
    await s3.send(
      new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: key,
        Body: file.buffer,
        ContentType: file.mimetype || "audio/webm",
      })
    );

    const mediaFileUri = `s3://${S3_BUCKET}/${key}`;

    // 2) Start Transcribe Job
    await transcribe.send(
      new StartTranscriptionJobCommand({
        TranscriptionJobName: jobId,
        LanguageCode: language,
        MediaFormat: guessMediaFormat(file.mimetype, file.originalname),
        Media: { MediaFileUri: mediaFileUri },
        Settings: {
          ShowSpeakerLabels: false,
          MaxSpeakerLabels: 2,
        },
      })
    );

    // 3) Poll until completed
    let status = "IN_PROGRESS";
    let transcriptUrl = null;

    for (let i = 0; i < 25; i++) {
      await sleep(2000);

      const job = await transcribe.send(
        new GetTranscriptionJobCommand({ TranscriptionJobName: jobId })
      );

      status = job.TranscriptionJob?.TranscriptionJobStatus;

      console.log("⏳ Job status:", status);

      if (status === "COMPLETED") {
        transcriptUrl = job.TranscriptionJob?.Transcript?.TranscriptFileUri;
        break;
      }

      if (status === "FAILED") {
        const reason = job.TranscriptionJob?.FailureReason || "Unknown failure";
        return res.status(500).json({ ok: false, error: "Transcribe failed", reason });
      }
    }

    if (!transcriptUrl) {
      return res.status(504).json({ ok: false, error: "Timeout waiting for transcription" });
    }

    // 4) Fetch transcript JSON from AWS
    const transcriptRes = await fetch(transcriptUrl);
    const transcriptJson = await transcriptRes.json();

    const text =
      transcriptJson?.results?.transcripts?.[0]?.transcript?.trim() || "";

    // 5) Cleanup uploaded file from S3 (optional but good)
    await s3.send(
      new DeleteObjectCommand({
        Bucket: S3_BUCKET,
        Key: key,
      })
    );

    return res.json({
      ok: true,
      jobId,
      language,
      text,
    });
  } catch (err) {
    console.error("❌ STT error:", err);
    return res.status(500).json({
      ok: false,
      error: "Server error",
      message: err?.message || "unknown",
    });
  }
});

function guessMediaFormat(mimetype, filename) {
  const name = (filename || "").toLowerCase();

  // AWS expects: mp3, mp4, wav, flac, ogg, amr, webm
  if (mimetype?.includes("webm") || name.endsWith(".webm")) return "webm";
  if (mimetype?.includes("wav") || name.endsWith(".wav")) return "wav";
  if (mimetype?.includes("mpeg") || name.endsWith(".mp3")) return "mp3";
  if (mimetype?.includes("ogg") || name.endsWith(".ogg")) return "ogg";
  if (name.endsWith(".mp4")) return "mp4";

  // default safe
  return "webm";
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`✅ Bharat STT Backend running on port ${PORT}`);
});
