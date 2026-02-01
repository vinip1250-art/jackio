FROM ghcr.io/linuxserver/jackett:latest

# Instala git para clonar o repositório
RUN apk add --no-cache git

# Clona seu repositório JackettIO
RUN git clone https://github.com/vinip1250-art/jackio.git /tmp/jackio

# Copia o código modificado para dentro da imagem
RUN cp -r /tmp/jackio/src/* /app/ && \
    chown -R abc:abc /app && \
    rm -rf /tmp/jackio
