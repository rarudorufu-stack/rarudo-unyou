import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import Anthropic from "@anthropic-ai/sdk";
import { TwitterApi } from "twitter-api-v2";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENGAGEMENT_LOG_PATH = path.join(__dirname, "engagement_log.json");

// ---- 検索クエリ（必要に応じて調整してください） ----
// 「家計・節約・管理栄養士」関連の会話を狙う。「教えて」「悩み」系を混ぜて質問・相談投稿を拾いやすくする
const SEARCH_QUERY =
  "(家計管理 OR 節約 OR 固定費見直し OR 管理栄養士) (教えて OR 悩んで OR どうしてる OR おすすめ OR コツ) -is:retweet -is:reply lang:ja";
const MAX_CANDIDATES = 5; // 1回の実行で提案する件数（読み取りコスト抑制のため少なめ）

// エンゲージメントが見込みやすいフォロワー数のレンジ（多すぎ=有名人/メディア、少なすぎ=実在感が薄いを除外）
const MIN_FOLLOWERS = 30;
const MAX_FOLLOWERS = 15000;

// 質問・相談を示唆するキーワード（該当するとスコアが上がる）
const QUESTION_SIGNALS = ["教えて", "悩んで", "どうしてる", "知りたい", "おすすめ", "？", "?"];

const PERSONA = `あなたは「らるど｜管理栄養士×家計再生」というXアカウントの中の人です。
管理栄養士の資格を持ち、食費と固定費を両方見直しながら生活コストを下げるノウハウを発信しています。
他人の投稿に対して、押し売り感のない、自然で共感的な一言リプライを考えるのが得意です。`;

async function loadEngagementLog() {
  try {
    const raw = await fs.readFile(ENGAGEMENT_LOG_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return { repliedOrSuggestedTweetIds: [] };
  }
}

async function saveEngagementLog(log) {
  await fs.writeFile(ENGAGEMENT_LOG_PATH, JSON.stringify(log, null, 2), "utf-8");
}

async function searchCandidates(alreadySeenIds) {
  const bearerClient = new TwitterApi(process.env.X_BEARER_TOKEN);
  const roClient = bearerClient.readOnly;

  const result = await roClient.v2.search(SEARCH_QUERY, {
    max_results: 30,
    "tweet.fields": ["author_id", "public_metrics", "created_at", "text"],
    expansions: ["author_id"],
    "user.fields": ["username", "public_metrics"],
  });

  const users = new Map(
    (result.includes?.users ?? []).map((u) => [u.id, u])
  );

  const candidates = [];
  for (const tweet of result.data?.data ?? []) {
    if (alreadySeenIds.includes(tweet.id)) continue;

    const user = users.get(tweet.author_id);
    if (!user) continue;

    const followerCount = user.public_metrics?.followers_count ?? 0;
    // フォロワー数が極端に多い（有名人/メディア）または少ない（実在感が薄い）アカウントは除外
    if (followerCount < MIN_FOLLOWERS || followerCount > MAX_FOLLOWERS) continue;

    const replyCount = tweet.public_metrics?.reply_count ?? 0;
    const likeCount = tweet.public_metrics?.like_count ?? 0;
    const text = tweet.text ?? "";
    const hasQuestionSignal = QUESTION_SIGNALS.some((kw) => text.includes(kw));

    // スコアリング：質問・相談系を優先し、返信が少なめ（埋もれていない）投稿を優遇
    let score = 0;
    if (hasQuestionSignal) score += 5;
    if (replyCount <= 3) score += 2;
    score += Math.min(likeCount, 20) * 0.1; // いいねは軽く加点（多すぎても差がつきすぎないよう上限あり）

    candidates.push({
      id: tweet.id,
      authorUsername: user.username,
      followerCount,
      likeCount,
      replyCount,
      hasQuestionSignal,
      score,
      url: `https://x.com/${user.username}/status/${tweet.id}`,
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, MAX_CANDIDATES);
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function draftReply(candidate) {
  const prompt = `${PERSONA}

以下はXで見つけた投稿の内容です（投稿者: @${candidate.authorUsername}）。

---
${candidate.text}
---

この投稿に返信するとしたら、どんな一言リプライが自然で好印象でしょうか。
押し売り感を出さず、内容に対する共感や軽いひとことアドバイスを意識してください。
返信文の中で投稿本文をそのまま引用しないでください（あなた自身の言葉で反応してください）。

また、後で人間が投稿内容をひと目で把握できるよう、投稿の要点を15文字程度で要約してください（原文の言い回しをそのまま使わず、自分の言葉で言い換えること）。

出力は必ず次のJSON形式のみとし、前置きやコードブロックは一切つけないでください。
{"gist": "投稿の要点（15文字程度、言い換え）", "draft_reply": "実際の返信文案（100文字以内）"}`;

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 400,
    messages: [{ role: "user", content: prompt }],
  });
  const textBlock = response.content.find((b) => b.type === "text");
  const rawText = textBlock?.text ?? "";
  const match = rawText.match(/\{[\s\S]*\}/);

  if (!match) {
    console.warn(`JSON抽出に失敗しました。生の応答: ${rawText}`);
    return { gist: "（要約失敗）", draft_reply: "（下書き生成に失敗しました。手動で内容を確認してください）" };
  }

  try {
    const parsed = JSON.parse(match[0]);
    return { gist: parsed.gist, draft_reply: parsed.draft_reply };
  } catch (e) {
    console.warn(`JSONパースに失敗しました: ${e.message}\n生の応答: ${rawText}`);
    return { gist: "（要約失敗）", draft_reply: "（下書き生成に失敗しました。手動で内容を確認してください）" };
  }
}

async function createGithubIssue(title, body) {
  const [owner, repo] = process.env.GITHUB_REPOSITORY.split("/");
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/issues`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
      },
      body: JSON.stringify({ title, body }),
    }
  );
  if (!response.ok) {
    throw new Error(`Issue作成に失敗しました: ${response.status} ${await response.text()}`);
  }
}

async function main() {
  const log = await loadEngagementLog();
  const candidates = await searchCandidates(log.repliedOrSuggestedTweetIds);

  if (candidates.length === 0) {
    console.log("新しい候補が見つかりませんでした。");
    return;
  }

  const drafts = [];
  for (const candidate of candidates) {
    const { gist, draft_reply } = await draftReply(candidate);
    drafts.push({ ...candidate, gist, draftReply: draft_reply });
  }

  const today = new Date().toISOString().slice(0, 10);
  const body = drafts
    .map(
      (d, i) =>
        `### ${i + 1}. @${d.authorUsername}（フォロワー約${d.followerCount}人）\n` +
        `- 投稿の要点: ${d.gist}\n` +
        `- 質問・相談系の投稿: ${d.hasQuestionSignal ? "はい" : "いいえ"}\n` +
        `- 投稿: ${d.url}\n` +
        `- 返信下書き案: 「${d.draftReply}」\n`
    )
    .join("\n");

  await createGithubIssue(`【返信下書き提案】${today}`, body);

  log.repliedOrSuggestedTweetIds.push(...candidates.map((c) => c.id));
  await saveEngagementLog(log);

  console.log(`${candidates.length}件の下書きをIssueとして提案しました。`);
}

main().catch((err) => {
  console.error("処理中にエラーが発生しました:", err);
  process.exit(1);
});