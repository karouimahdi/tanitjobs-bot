// The only module allowed to call the Telegram Bot API (CLAUDE.md invariant
// #3). Owns MarkdownV2 escaping and 429 backoff so nothing else in the
// pipeline has to know Telegram's quirks, and is the one place that reads
// TELEGRAM_CHAT_ID.

const TELEGRAM_API = "https://api.telegram.org";

// https://core.telegram.org/bots/api#markdownv2-style — every one of these
// breaks formatting, or silently drops the whole message, if left unescaped.
const MARKDOWN_V2_SPECIAL_CHARS = /[_*[\]()~`>#+\-=|{}.!\\]/g;

export function escapeMarkdownV2(text: string): string {
  return text.replace(MARKDOWN_V2_SPECIAL_CHARS, (char) => `\\${char}`);
}

export interface SendMessageOptions {
  /** Text is already MarkdownV2-escaped (or hand-composed) — skip auto-escaping. */
  raw?: boolean;
}

// Telegram asks bots to stay near 1 msg/sec per chat; at single-user volume
// the only realistic failure is an occasional 429, so this retries a bounded
// number of times using the `retry_after` Telegram hands back.
const MAX_RETRIES = 3;

export async function sendMessage(text: string, options: SendMessageOptions = {}): Promise<void> {
  const token = process.env["TELEGRAM_BOT_TOKEN"];
  const chatId = process.env["TELEGRAM_CHAT_ID"];

  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set");
  if (!chatId) throw new Error("TELEGRAM_CHAT_ID is not set");

  const body = options.raw === true ? text : escapeMarkdownV2(text);
  const url = `${TELEGRAM_API}/bot${token}/sendMessage`;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: body,
        parse_mode: "MarkdownV2",
        disable_web_page_preview: true,
      }),
    });

    if (response.ok) return;

    if (response.status === 429 && attempt < MAX_RETRIES) {
      const payload = (await response.json().catch(() => null)) as {
        parameters?: { retry_after?: number };
      } | null;
      const retryAfterSeconds = payload?.parameters?.retry_after ?? 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, retryAfterSeconds * 1000));
      continue;
    }

    const errorBody = await response.text().catch(() => "");
    throw new Error(`Telegram sendMessage failed: ${response.status} ${errorBody}`);
  }

  throw new Error("Telegram sendMessage failed: exhausted retries after repeated 429s");
}
