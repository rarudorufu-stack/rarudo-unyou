import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import Anthropic from "@anthropic-ai/sdk";
import { TwitterApi } from "twitter-api-v2";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENGAGEMENT_LOG_PATH = path.join(__dirname, "engagement_log.json");

// ---- 検索クエリ（必要に応じて調整してください） ----
// 「家計・節約・管理栄養士」関連の会話を狙う
const SEARCH_QUERY =
  "(家計管理 OR 節約 OR 固定費見直し OR 管理栄養士) -is:retweet -is:reply lang:ja";
const MAX_CANDIDATES = 5; // 1回の実行で提案する件数（読み取りコスト抑制のため少なめ）

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
    max_results: 20,
    "tweet.fields": ["author_id", "public_metrics", "created_at"],
    expansions: ["author_id"],
    "user.fields": ["username"],
  });

  const users = new Map(
    (result.includes?.users ?? []).map((u) => [u.id, u.username])
  );

  const candidates = [];
  for (const tweet of result.data?.data ?? []) {
    if (alreadySeenIds.includes(tweet.id)) continue;
    candidates.push({
      id: tweet.id,
      authorUsername: users.get(tweet.author_id) ?? "unknown",
      likeCount: tweet.public_metrics?.like_count ?? 0,
      url: `https://x.com/${users.get(tweet.author_id) ?? "i"}/status/${tweet.id}`,
    });
  }

  // エンゲージメント数が多い順に並べて上位のみ採用
  candidates.sort((a, b) => b.likeCount - a.likeCount);
  return candidates.slice(0, MAX_CANDIDATES);
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function draftReply(candidate) {
  const prompt = `${PERSONA}

以下のツイートに返信するとしたら、どんな一言リプライが自然で好印象でしょうか。
（ツイート本文は直接引用せず、あなたが投稿への反応として送る返信文だけを考えてください）

ツイートURL: ${candidate.url}
投稿者: @${candidate.authorUsername}

以下のJSON形式のみで出力してください。
{
  "draft_reply": "実際の返信文案（100文字以内、押し売り感のない自然な一言）"
}`;

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 300,
    messages: [{ role: "user", content: prompt }],
  });
  const textBlock = response.content.find((b) => b.type === "text");
  const match = textBlock.text.match(/\{[\s\S]*\}/);
  return JSON.parse(match[0]).draft_reply;
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
    const draftReply = await draftReply(candidate);
    drafts.push({ ...candidate, draftReply });
  }

  const today = new Date().toISOString().slice(0, 10);
  const body = drafts
    .map(
      (d, i) =>
        `### ${i + 1}. @${d.authorUsername}\n- 投稿: ${d.url}\n- 返信下書き案: 「${d.draftReply}」\n`
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
