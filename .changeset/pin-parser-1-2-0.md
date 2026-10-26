---
"@dierkens.dev/ptcgl-battle-log-state": patch
---

Pin `@dierkens.dev/ptcgl-battle-log-parser` to 1.2.0, which matches straight and
curly apostrophes as the same character. Before it, a damage line printed with a
straight apostrophe lowered to an attack with the damage clause swallowed into
its name — 3.4% of attacks across a 411-log corpus.

The vendored fixtures and their shape projections are refreshed from 1.2.0, and
the breakdown check is narrowed to impossibility: listed components may not sum
to more than the printed total, because a printed total does not imply a complete
list.
