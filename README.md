# Jackio 🎬

Jackio é um addon avançado para Stremio, focado em buscar, resolver e fazer streaming de torrents de forma inteligente. Construído como um fork direto do [Jackettio](https://github.com/aymene69/jackettio), o Jackio expande massivamente a compatibilidade com novos serviços de debrid, proxys, metadados, indexadores e clientes de torrent, oferecendo uma experiência muito mais flexível e robusta.

---

## ✨ Principais Recursos e Diferenciais (vs. Jackettio Original)

O Jackio vai muito além da integração padrão com Jackett e os debrids clássicos. Abaixo estão as exclusividades e melhorias desta versão:

### 🔍 Indexadores Avançados (Jackett & Prowlarr)
* **Suporte Dual/Híbrido**: Compatibilidade nativa com **Jackett e/ou Prowlarr**, permitindo configurar e rodar **até duas instâncias simultaneamente** para maximizar e paralelizar a busca de fontes.
* **Catálogo RSS**: Sistema de catálogo integrado baseado em feeds RSS, exibindo os últimos lançamentos diretamente do tracker selecionado dentro da interface do Stremio.

### 🚀 Novos Serviços de Debrid e Streaming
* **TorBox**: Suporte nativo ao serviço de debrid TorBox.
* **StremThru**: Integração completa com o StremThru, permitindo gerenciamento avançado de conexões e cache otimizado.
* **TorrServer**: Streaming direto de torrents *on-the-fly* sem depender exclusivamente de serviços de debrid em nuvem.
* **Modo Híbrido & Offcloud**: Lógica avançada para combinar múltiplos provedores e suporte nativo ao Offcloud.

### 🌐 Integração com Proxys e Clientes
* **Mediaflow Proxy**: Integração com Mediaflow Proxy para roteamento inteligente de tráfego, contornando bloqueios regionais e otimizando a entrega da mídia.
* **qBittorrent Provider**: Além de enviar para debrids, o Jackio pode se comunicar diretamente com instâncias locais ou remotas do qBittorrent.

### 📊 Enriquecimento de Dados e Automação
* **Torrent Enricher**: Algoritmos para tratar, limpar e enriquecer as informações extraídas dos torrents (tamanho, qualidade, idioma, codec) antes de exibi-las no Stremio.
* **Metadados Expandidos**: Integração superior para identificar corretamente Animes (via Kitsu) e correspondência precisa de filmes/séries através do TMDB e Cinemeta.

---

---

### compose.yml

```yaml
services:
  jackio:
    build: .
    container_name: jackio
    restart: unless-stopped
    user: "1000:1000"
    ports:
      - "3000:3000"
    env_file:
      - .env
      environment:
      NODE_ENV: production
      DATA_FOLDER: /data
    volumes:
      - ./media:/data
