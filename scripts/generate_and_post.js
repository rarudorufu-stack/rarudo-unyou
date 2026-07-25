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

const PERSONA = `あなたは「たつや｜管理栄養士×家計再生」というXアカウントの中の人です。
管理栄養士の国家資格を持ち、食費と固定費を両方見直しながら生活コストを下げるノウハウを発信しています。
専門用語は使いすぎず、フォロワーが「今日から使える」と感じる具体性を大事にしてください。
車の維持費ネタは月に1〜2回程度に留め、基本は食費・固定費・暮らし全般の節約知識を扱います。`;

function buildPrompt(postType, usedTopics) {
  const avoidList = usedTopics.length
    ? `直近で使用済みのトピック（これらとは違う切り口にしてください）：\n${usedTopics.slice(-20).join("\n")}`
    : "まだ使用済みトピックはありません。";

  if (postType === "knowledge") {
    return `${PERSONA}

今日は「knowledgeポスト」（テキストのみ、280文字以内のX投稿）を1本作成してください。
${avoidList}

以下のJSON形式のみで出力してください。前置き・説明・コードブロックは一切不要です。
{
  "topic": "投稿の要点を10文字程度で",
  "text": "実際の投稿文（280文字以内、絵文字は控えめに1〜2個まで）"
}`;
  }

  if (postType === "conversation") {
    return `${PERSONA}

今日は「会話誘発ポスト」（フォロワーがリプライしたくなる質問形式の投稿、140文字以内）を1本作成してください。
${avoidList}

以下のJSON形式のみで出力してください。
{
  "topic": "投稿の要点を10文字程度で",
  "text": "実際の投稿文（質問で終わる、140文字以内）"
}`;
  }

  // quiz
  return `${PERSONA}

今日は「クイズ投稿」を作成してください。3枚の画像スライド（導入・問題・答え）＋Xのキャプション文で構成します。
${avoidList}

以下のJSON形式のみで出力してください。
{
  "topic": "投稿の要点を10文字程度で",
  "caption": "1枚目の画像に添えるXの本文（フックになる一文、100文字以内）",
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

async function generateContent(postType, usedTopics) {
  const prompt = buildPrompt(postType, usedTopics);
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1000,
    messages: [{ role: "user", content: prompt }],
  });
  const textBlock = response.content.find((b) => b.type === "text");
  return extractJson(textBlock.text);
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

async function postTextOnly(text) {
  const client = getTwitterClient();
  await client.v2.tweet(text);
}

async function postQuizThread(content, imagePaths) {
  const client = getTwitterClient();

  // 1枚目の画像＋キャプションで最初のツイート
  const mediaId1 = await client.v1.uploadMedia(imagePaths[0]);
  const tweet1 = await client.v2.tweet({
    text: content.caption,
    media: { media_ids: [mediaId1] },
  });

  // 2枚目：問題スライドをリプライで連結
  const mediaId2 = await client.v1.uploadMedia(imagePaths[1]);
  const tweet2 = await client.v2.tweet({
    text: "問題はこちら👇",
    media: { media_ids: [mediaId2] },
    reply: { in_reply_to_tweet_id: tweet1.data.id },
  });

  // 3枚目：答えスライドをさらにリプライで連結
  const mediaId3 = await client.v1.uploadMedia(imagePaths[2]);
  await client.v2.tweet({
    text: "答え・解説はこちら👇",
    media: { media_ids: [mediaId3] },
    reply: { in_reply_to_tweet_id: tweet2.data.id },
  });
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
