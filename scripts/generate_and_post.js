import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import Anthropic from "@anthropic-ai/sdk";
import { TwitterApi } from "twitter-api-v2";
import puppeteer from "puppeteer";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOPICS_LOG_PATH = path.join(__dirname, "topics_log.json");
const TEMPLATE_PATH = path.join(__dirname, "..", "templates", "quiz_template.html");

// ---- 1. 曜日ごとの投稿タイプ ----
// 0=日, 1=月, 2=火, 3=水, 4=木, 5=金, 6=土
const POST_TYPE_BY_DAY = {
  0: "conversation",
  1: "knowledge",
  2: "quiz",
  3: "knowledge",
  4: "quiz",
  5: "knowledge",
  6: "quiz",
};

function getJstWeekday() {
  const now = new Date();
  // UTC + 9時間 = JST
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return jst.getUTCDay();
}

async function loadTopicsLog() {
  const raw = await fs.readFile(TOPICS_LOG_PATH, "utf-8");
  return JSON.parse(raw);
}

async function saveTopicsLog(log) {
  await fs.writeFile(TOPICS_LOG_PATH, JSON.stringify(log, null, 2), "utf-8");
}

// ---- 2. Claudeでコンテンツ生成 ----
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const PERSONA = `あなたは「らるど｜管理栄養士×家計再生」というXアカウントの中の人です。
管理栄養士の国家資格を持ち、食費と固定費を両方見直しながら生活コストを下げるノウハウを発信しています。
専門用語は使いすぎず、フォロワーが「今日から使える」と感じる具体性を大事にしてください。
車の維持費ネタは月に1〜2回程度に留め、基本は食費・固定費・暮らし全般の節約知識を扱います。`;

function buildPrompt(postType, usedTopics) {
  const avoidList = usedTopics.length
    ? `直近で使用済みのトピック（これらとは違う切り口にしてください）：\n${usedTopics.slice(-20).join("\n")}`
    : "まだ使用済みトピックはありません。";

  if (postType === "knowledge") {
    return `${PERSONA}

今日は「knowledgeポスト」（テキストのみのX投稿）を1本作成してください。
Xは全角文字を2文字分としてカウントするため、全角130文字以内（英数字なら260文字以内の感覚）を厳守してください。280文字ギリギリを狙うと日本語では文字数超過エラーになるため、少し余裕を持たせて簡潔にまとめてください。
${avoidList}

以下のJSON形式のみで出力してください。前置き・説明・コードブロックは一切不要です。
{
  "topic": "投稿の要点を10文字程度で",
  "text": "実際の投稿文（全角130文字以内、絵文字は控えめに1〜2個まで）"
}`;
  }

  if (postType === "conversation") {
    return `${PERSONA}

今日は「会話誘発ポスト」（フォロワーがリプライしたくなる質問形式の投稿）を1本作成してください。
Xは全角文字を2文字分としてカウントするため、全角100文字以内に収めてください。
${avoidList}

以下のJSON形式のみで出力してください。
{
  "topic": "投稿の要点を10文字程度で",
  "text": "実際の投稿文（質問で終わる、全角100文字以内）"
}`;
  }

  // quiz
  return `${PERSONA}

今日は「クイズ投稿」を作成してください。3枚の画像スライド（導入・問題・答え）＋Xのキャプション文で構成します。
Xは全角文字を2文字分としてカウントするため、キャプションは全角70文字以内に収めてください。
${avoidList}

以下のJSON形式のみで出力してください。
{
  "topic": "投稿の要点を10文字程度で",
  "caption": "1枚目の画像に添えるXの本文（フックになる一文、全角70文字以内）",
  "slide_intro": { "label": "QUIZ", "title": "クイズのタイトル（20文字程度）", "body": "導入文（60文字程度）" },
  "slide_question": { "label": "問題", "title": "問題文（30文字程度）", "body": "選択肢など（80文字程度）" },
  "slide_answer": { "label": "答え", "title": "正解（20文字程度）", "body": "解説（100文字程度）" }
}`;
}

function extractJson(text) {
  // コードブロックで囲まれていた場合に備えて中身だけ取り出す
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("JSON形式の応答が見つかりませんでした: " + text);
  return JSON.parse(match[0]);
}

// Xの文字数カウントを簡易再現：全角相当の文字（ひらがな・カタカナ・漢字など）は2文字分としてカウント
function weightedLength(text) {
  let length = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    length += code > 0x1000 ? 2 : 1;
  }
  return length;
}

// Xの投稿上限（280）を超えないよう安全に切り詰める。超過していた場合は警告ログを出す
function enforceXLength(text, label, limit = 280) {
  if (weightedLength(text) <= limit) return text;

  console.warn(
    `⚠️ ${label}がX文字数上限を超過（推定${weightedLength(text)}/${limit}）。安全のため切り詰めます。プロンプト側の指示を見直すことを推奨します。`
  );

  let result = "";
  for (const ch of text) {
    const nextLength = weightedLength(result + ch);
    if (nextLength > limit - 1) break; // 末尾に"…"を1文字分残す余裕を確保
    result += ch;
  }
  return result + "…";
}

async function generateContent(postType, usedTopics) {
  const prompt = buildPrompt(postType, usedTopics);
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1000,
    messages: [{ role: "user", content: prompt }],
  });
  const textBlock = response.content.find((b) => b.type === "text");
  const content = extractJson(textBlock.text);

  // 投稿本文の文字数を安全側でチェック・補正
  if (content.text) {
    content.text = enforceXLength(content.text, "投稿本文");
  }
  if (content.caption) {
    content.caption = enforceXLength(content.caption, "キャプション");
  }

  return content;
}

// ---- 3. クイズ画像の生成（HTML→スクリーンショット） ----
async function renderSlide(slideData, outputPath) {
  const templateHtml = await fs.readFile(TEMPLATE_PATH, "utf-8");
  const html = templateHtml
    .replace("{{LABEL}}", slideData.label ?? "")
    .replace("{{TITLE}}", slideData.title ?? "")
    .replace("{{BODY}}", slideData.body ?? "");

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1080, height: 1080 });
    await page.setContent(html, { waitUntil: "networkidle0" });
    await page.screenshot({ path: outputPath });
  } finally {
    await browser.close();
  }
}

async function renderQuizSlides(content) {
  const tmpDir = path.join(__dirname, "..", "tmp");
  await fs.mkdir(tmpDir, { recursive: true });

  const slides = [
    { key: "slide_intro", file: "slide1.png" },
    { key: "slide_question", file: "slide2.png" },
    { key: "slide_answer", file: "slide3.png" },
  ];

  const paths = [];
  for (const s of slides) {
    const outputPath = path.join(tmpDir, s.file);
    await renderSlide(content[s.key], outputPath);
    paths.push(outputPath);
  }
  return paths;
}

// ---- 4. Xへの投稿 ----
function getTwitterClient() {
  return new TwitterApi({
    appKey: process.env.X_API_KEY,
    appSecret: process.env.X_API_SECRET,
    accessToken: process.env.X_ACCESS_TOKEN,
    accessSecret: process.env.X_ACCESS_SECRET,
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// X API Pay-Per-Useの書き込み系エンドポイントで断続的に403が返る既知の不具合への対策。
// 403の場合は少し待って複数回リトライする（成功するまで、または最大回数に達するまで）。
async function withRetry(fn, { maxAttempts = 5, delaysMs = [15000, 30000, 60000, 120000] } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const is403 = err?.code === 403;
      const isLastAttempt = attempt === maxAttempts;

      if (!is403 || isLastAttempt) {
        throw err;
      }

      const delay = delaysMs[Math.min(attempt - 1, delaysMs.length - 1)];
      console.warn(
        `403エラーを検知（${attempt}/${maxAttempts}回目）。${delay / 1000}秒待って再試行します...`
      );
      await sleep(delay);
    }
  }
  throw lastError;
}

async function postTextOnly(text) {
  const client = getTwitterClient();
  await withRetry(() => client.v2.tweet(text));
}

async function postQuizThread(content, imagePaths) {
  const client = getTwitterClient();

  // 1枚目の画像＋キャプションで最初のツイート
  const mediaId1 = await client.v1.uploadMedia(imagePaths[0]);
  const tweet1 = await withRetry(() =>
    client.v2.tweet({
      text: content.caption,
      media: { media_ids: [mediaId1] },
    })
  );

  // 2枚目：問題スライドをリプライで連結
  const mediaId2 = await client.v1.uploadMedia(imagePaths[1]);
  const tweet2 = await withRetry(() =>
    client.v2.tweet({
      text: "問題はこちら👇",
      media: { media_ids: [mediaId2] },
      reply: { in_reply_to_tweet_id: tweet1.data.id },
    })
  );

  // 3枚目：答えスライドをさらにリプライで連結
  const mediaId3 = await client.v1.uploadMedia(imagePaths[2]);
  await withRetry(() =>
    client.v2.tweet({
      text: "答え・解説はこちら👇",
      media: { media_ids: [mediaId3] },
      reply: { in_reply_to_tweet_id: tweet2.data.id },
    })
  );
}

// ---- 5. メイン処理 ----
async function main() {
  const weekday = getJstWeekday();
  const postType = POST_TYPE_BY_DAY[weekday];
  console.log(`本日の投稿タイプ: ${postType}`);

  const log = await loadTopicsLog();
  const usedTopics = log[postType] ?? [];

  const content = await generateContent(postType, usedTopics);
  console.log("生成結果:", content);

  if (postType === "quiz") {
    const imagePaths = await renderQuizSlides(content);
    await postQuizThread(content, imagePaths);
  } else {
    await postTextOnly(content.text);
  }

  log[postType] = [...usedTopics, content.topic];
  await saveTopicsLog(log);

  console.log("投稿が完了しました。");
}

main().catch((err) => {
  console.error("投稿処理でエラーが発生しました:", err);
  process.exit(1);
});
