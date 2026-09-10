// TODO(TKT-021): Anthropic structured-output classification, cached by
// sha256(title+company+location+description) in classifications/{hash}.
//
// This file is CLAUDE.md's documented exception to "no `any`" — the Anthropic
// SDK's structured-output typing gap lives here and only here. Nothing else
// in the codebase gets to reach for `any` by citing this comment.

export {};
