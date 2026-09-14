# Contact CourtListener only from bounded deployment canaries

Pull-request CI will never contact CourtListener; it will use fixed response fixtures and in-memory adapters, while workerd integration tests exercise real local D1, R2, and Durable Object bindings. Each staging deployment will run one bounded live CourtListener canary through the normal budget coordinator. Production smoke tests will verify authentication, discovery, schemas, parsing, and cached verification without forcing an upstream fetch. Live production revalidation remains an explicit manual diagnostic.
