---
impacto: capacidade_nova
secao: adicionado
titulo: Pela API, o ERP fecha o negócio, registra notas e cria tarefas
---

Com o token de integração, um sistema externo agora consegue:

- **marcar o negócio como ganho ou perdido** numa chamada só
  (`POST /api/v1/leads/{id}/win` e `/lose`), sem precisar saber qual é a etapa
  de fechamento de cada funil — por exemplo, quando o pedido é faturado ou
  cancelado. Valem as mesmas regras da tela: motivo do vocabulário do funil e
  campos obrigatórios;
- **registrar uma nota na linha do tempo do negócio**
  (`POST /api/v1/leads/{id}/notes`), como "nota fiscal emitida" ou "boleto
  vencido", para o vendedor ver;
- **criar e listar tarefas** (`/api/v1/tasks`) ligadas ao negócio, ao contato e
  a um responsável.
