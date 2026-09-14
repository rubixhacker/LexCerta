# Store source-cache metadata in D1 and opinions in R2

LexCerta will store citation results, provenance, freshness timestamps, and opinion-object references in Cloudflare D1. Full opinion text will use Cloudflare R2 Standard because legal documents can exceed D1's row-size limit. Worker memory may provide a disposable speed layer but is never the authoritative source cache; Supabase is not part of this storage path.
