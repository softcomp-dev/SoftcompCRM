---
impacto: capacidade_nova
secao: adicionado
titulo: Cada produto da proposta tem o seu status, e o cliente pode aceitar só parte
---

Quem negocia vários produtos com o mesmo cliente agora vê, no card do negócio, a tabela dos
itens da proposta com **Descrição**, **Valor unitário**, **Quantidade**, **Total** e
**Status**. Com a proposta enviada, marque cada item como **Pendente**, **Aceito** ou
**Recusado**. Quando nenhum item fica pendente, a proposta se resolve sozinha: aceita se
algum produto foi aceito, recusada se todos foram recusados. O valor do negócio passa a
ser a soma dos itens aceitos.

Depois que a cotação aceita vira pedido (marque o negócio como **Pedido** no campo
"Número da cotação ou do pedido"), cada item aceito pode ir para **Em produção** e
**Entregue**. Os botões "Marcar como aceita/recusada" continuam valendo para a proposta
inteira.

A atualização aplica a migration sozinha. Os itens de propostas já aceitas ou recusadas
recebem o status da decisão.
