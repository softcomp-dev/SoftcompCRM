---
impacto: nada_mudou
secao: corrigido
titulo: A API de integração explica melhor quando recusa um pedido
---

Quem integra outro sistema ao CRM pela API passa a receber respostas de erro mais claras:

- Depois de várias tentativas com um token errado, a resposta é `429 rate_limited` com o
  cabeçalho `Retry-After`, que diz quantos segundos esperar. Antes vinha `forbidden`, sem
  dizer que bastava esperar.
- Uma regra de automação enviada com um campo inválido (por exemplo, um evento que não
  existe) é recusada com `422 validation_failed`, como no resto da API. Um JSON ilegível
  continua com `400`.
- Ao publicar uma versão de agente de IA, a recusa diz o motivo: falta canal, falta
  credencial, a credencial está desativada ou não foi validada, e assim por diante. Antes
  a mensagem era sempre "Validação de publish falhou."
- Pedir as etapas de um funil ou as versões de um agente que não existe na organização
  responde `404`. Antes vinha uma lista vazia, igual à de um funil sem etapas.
- Quando falta uma informação que vale para o pedido inteiro (por exemplo, abrir conversa
  sem `contact_id` nem `phone_number`), a mensagem do erro diz o que falta.

A documentação da API (Swagger) foi atualizada junto: o exemplo de motivo de perda passou
a ser `price`, e a lista de motivos aceitos está na própria operação.
