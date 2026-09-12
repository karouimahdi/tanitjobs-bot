// npm run tg:check — sends one test message to confirm TELEGRAM_BOT_TOKEN and
// TELEGRAM_CHAT_ID actually work end to end. See README "Telegram in two minutes".

import { sendMessage } from "./send.js";

await sendMessage(`tanitjobs-bot: tg:check ping — delivery works. (${new Date().toISOString()})`);

console.log("tg:check: message sent — check Telegram.");
