FROM node:18-alpine

WORKDIR /app

# Instala git (Alpine)
RUN apk add --no-cache git

COPY package*.json ./
RUN npm install --production

COPY . .

EXPOSE 7000

CMD ["npm", "start"]
