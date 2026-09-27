# Specs

Toda especificação, decisão e plano da POC fica aqui.

> Status: experimento técnico (POC arquitetural), publicado para estudo. Não é production-ready.
> Uma POC equivalente com AI SDK será comparada futuramente executando os mesmos cenários.

| Documento                                  | Conteúdo                                                                                                            |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| [architecture.md](architecture.md)         | Camadas, fluxos, segurança, observabilidade, **conclusão generic vs semantic tools**, achados empíricos, limitações |
| [evaluation.md](evaluation.md)             | Fase 12: método de avaliação (live vs adversarial), portabilidade, resultados e findings                            |
| [evaluation-cases.md](evaluation-cases.md) | Catálogo legível dos casos de avaliação                                                                             |
| [roadmap.md](roadmap.md)                   | Fases 0–11 com o que foi feito, como foi validado e o balanço final                                                 |
| [decisions/](decisions/)                   | ADRs curtos                                                                                                         |

## ADRs

| #                                                        | Decisão                                                                          |
| -------------------------------------------------------- | -------------------------------------------------------------------------------- |
| [001](decisions/001-mastra-embedded-in-nextjs.md)        | Mastra como framework de agentes, embutido no Next.js                            |
| [002](decisions/002-read-write-separation.md)            | Separação READ (capability genérica controlada) vs WRITE (só Domain Actions)     |
| [003](decisions/003-domain-actions-as-tools.md)          | Domain Actions como tools semânticas, nunca CRUD                                 |
| [004](decisions/004-authorization-and-human-approval.md) | Autorização no backend e aprovação humana em duas camadas (evidência persistida) |
| [005](decisions/005-agent-vs-workflow.md)                | Quando usar Agent e quando usar Workflow                                         |
| [006](decisions/006-mcp-strategy.md)                     | Estratégia MCP: capabilities de leitura via stdio primeiro                       |
