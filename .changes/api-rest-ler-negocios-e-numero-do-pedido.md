---
impacto: capacidade_nova
secao: adicionado
titulo: Pela API, o ERP lê os negócios e acha cada um pelo número do pedido
---

Com o token de integração, um sistema externo agora consegue:

- **criar o negócio com o número do pedido** (`external_id`). Se já existir
  negócio com esse número na mesma origem, a resposta traz o identificador do
  existente em vez de criar outro;
- **ler um negócio** pelo identificador (`GET /api/v1/leads/{id}`) ou pelo
  número do pedido (`GET /api/v1/leads/by-external/{origem}/{número}`), com
  etapa, situação, responsável, valor e campos;
- **listar o que mudou** (`GET /api/v1/leads?updated_since=…`), em ordem estável
  e com paginação, para conferir o que um aviso por webhook possa ter perdido.

As leituras respeitam o mesmo limite de chamadas por minuto das escritas, e
negócios de contatos marcados como pessoais não aparecem.
