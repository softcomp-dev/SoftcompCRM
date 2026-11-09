---
impacto: capacidade_nova
secao: adicionado
titulo: Um sistema externo (como um ERP) cria e move cards do funil pela API REST, com token
---

Até aqui, um sistema de fora só conseguia criar card, mudar etapa e descobrir
os funis pelo servidor MCP, num formato pensado para agentes de IA. Agora essas
operações também aceitam um token de **Configurações › API Tokens**
(`Authorization: Bearer dsk_…`) nas rotas REST comuns:

- `GET /api/v1/pipelines` e `GET /api/v1/pipelines/{id}/stages` listam funis e
  etapas (permissão "Agentes de IA podem LER o CRM");
- `POST /api/v1/leads` cria o card e `POST /api/v1/leads/{id}/move` muda a
  etapa, só com `stage_id` e os motivos opcionais (permissão "Agentes de IA
  podem AGIR no CRM").

As regras são as mesmas da tela: campos obrigatórios da etapa, motivo de ganho
e de perda e reabertura de negócio encerrado. Cada token tem um limite de
30 chamadas por minuto em cada grupo de rotas (funis e etapas, cards). Nada muda
para quem usa o CRM pela tela, e a instalação não precisa de nenhuma ação. A
referência das rotas que aceitam token está em `docs/api/openapi.yaml`.
