---
"@dierkens.dev/ptcgl-battle-log-state": minor
---

Track the Stadium in play and the Bench limit it allows:

- "X played a card." lowers to a new `hiddenPlay` event (side only) in every locale, instead of a `play` of a card named "a card".
- `CardOracle` gains an optional `stadium(name)` lookup returning `StadiumFacts { benchLimit }`; `benchLimitFromText` reads the limit from English Stadium text. The condition on it (Area Zero Underdepths' Tera rule) is dropped, so the limit is a ceiling and `BenchOverflow` only fires above it.
- The ledger tracks the Stadium played to the Stadium spot. Only a new Stadium proves the old one left, since a discard naming it may be another copy from the hand.
- Discards after a hidden play, while a raising Stadium is in play or in the phase it was replaced, are the Bench being cut back: each named Pokémon leaves the Bench, and the discard lines that follow say which body it was.
