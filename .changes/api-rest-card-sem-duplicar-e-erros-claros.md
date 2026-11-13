---
impacto: capacidade_nova
secao: alterado
titulo: A API de cards por token evita card duplicado e explica melhor as recusas
---

Quem integra um sistema externo (como um ERP) pela API REST ganha quatro coisas
na criação e na mudança de etapa de cards:

- **Card não duplica mais em caso de repetição.** `POST /api/v1/leads` aceita o
  cabeçalho `Idempotency-Key`: se a chamada der timeout e o sistema repetir com a
  mesma chave, recebe o mesmo card de volta em vez de criar outro.
- **Etapa arquivada é recusada com instrução.** Antes, um sistema que guardou o
  id de uma etapa seguia criando e movendo cards para ela depois de arquivada,
  sem aviso. Agora a resposta é 422 e diz para ler as etapas de novo. Criar card
  direto em etapa de ganho ou de perda também é recusado, como a documentação já
  dizia.
- **Erro interno não mostra mais texto do banco de dados.** A resposta traz uma
  mensagem genérica e o `X-Request-Id`, e o detalhe fica no log da instalação.
- **A recusa por campo obrigatório diz quais campos faltam** também na criação
  (`details.faltando`), como já acontecia ao mudar de etapa.

Na tela **Documentação da API**, o botão de testar passa a chamar o endereço em
que a página está aberta. Antes ele usava o endereço configurado na instalação e
falhava para quem acessava por outro domínio. A documentação também ganhou o que
faltava: os limites de uso contados por recurso e os códigos de recusa novos.

Para quem já integra: a única mudança que pode exigir ajuste é a recusa de etapa
arquivada e de etapa de fechamento na criação. A atualização não muda o banco e
não pede nada a quem opera a VPS.
