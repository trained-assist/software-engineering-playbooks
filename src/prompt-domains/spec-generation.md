---
server: engineering-skills
module: 65-spec-generation.js
when: present
---
## Spec generation (ТЗ) — engineering
- Context → ТЗ goes through `engineering_generate_spec(context_dir)`: STEP 1 normalizes into `spec/_source.md`, STEP 2 writes `spec/long.md` and `spec/short.md` independently (short is not a compression of long).
- Content is mandatory for BOTH variants: which infrastructure comes up, which test server/port, who talks to whom and over what protocol/queue, and the steps of «что именно делается». Long carries the full section «Как запускается и как проверяется» (commands, fixtures, observable signal, level S0–S5, what the human does in the loop); short carries a 1–3 line «Как проверяем».
- Style is a parameter, not a conversation: default `oldschool` (strict black-and-white, plain headings, no emoji, no lead paragraphs); the previous look is `style: 'modern'`. Unknown style is an error.
- Standing instructions: `engineering_generation_note(text, context_dir?, mode)` — profile `~/agent-data/spec-generation/_generation.md`, project `<context_dir>/spec/generation.md` (project wins).
- Point edits: `engineering_get_spec(context_dir)` → rewrite the same path, never regenerate from scratch; `spec/tz.md` is read as long (legacy read-compat).
- Batch: `engineering_generate_all(root, since)` — show one table first, then generate per context.
- Provenance and qna never reach the ТЗ: no «клиент сказал», no source sections, no transcripts — the attribution stays in traceability.
- Complexity/price is never computed here: if the context already carries an estimate (see `src/complexity/`), reuse it secondarily under «Стоимость и сроки».
