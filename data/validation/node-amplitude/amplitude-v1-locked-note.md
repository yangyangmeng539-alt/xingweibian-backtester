# amplitude-v1 locked

date: 2026-06-13
scope: CN_A node prediction yellow-line amplitude layer
status: LOCKED

passed:
- in-sample large audit totalRows ~= 8535
- out-of-sample audit totalRows ~= 8223
- future isolation validation ok

locked shapes:
- PULSE
- MIXED
- FAIL with state/liquidity interaction
- TREND
- DECAY with liquidity interaction

do not tune again by mean gap only.
next step: direction hit-rate layer / risk bucket split.
