# Rotate the proxy session on TIMEOUTS too, not just 401/403 — a black-holed egress looks like silence.
Rotation only fired on auth statuses, so when a Decodo egress started black-holing
connections, every retry re-fed the same dead IP: 16 admission slots hung 435s+ and
throughput collapsed 728→15 searches/5m. Fix: the transient catch (timeout/socket
error) also calls rotateProxySession() (single-flight coalesced). Recovery to full
throughput was immediate after deploy.
