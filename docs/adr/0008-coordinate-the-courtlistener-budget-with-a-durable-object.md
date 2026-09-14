# Coordinate the CourtListener budget with a Durable Object

LexCerta will use one SQLite-backed Cloudflare Durable Object per CourtListener credential to authorize each outbound CourtListener request immediately before it is sent. The stateless Worker remains responsible for the external request, while the Durable Object owns the strongly consistent service-wide quota and throttling state; D1 remains the authority for Customer and API key records.
