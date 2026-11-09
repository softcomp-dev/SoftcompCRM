---
impacto: capacidade_nova
secao: adicionado
titulo: A documentação da API abre dentro do CRM, em /docs, com teste pelo navegador
---

Quem integra outro sistema (um ERP, uma loja, uma automação) agora encontra a
documentação da API dentro do próprio CRM: em `/docs`, ou no menu
**Organização › Dados e acesso › Documentação da API**. A tela de **API Tokens**
também tem o link.

É a referência no padrão Swagger das rotas que aceitam token. Ela aparece com o
nome da sua marca e já aponta para o endereço da sua instalação. Para testar uma
rota, cole o token no botão **Authorize**. O teste usa só o token, sem a sua
sessão, então o resultado é o mesmo que o seu sistema vai receber. A página
exige login, e o token colado fica só naquela aba.
