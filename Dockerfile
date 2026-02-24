FROM node:24

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY src ./src

ENV ORDER_HOST=0.0.0.0
ENV ORDER_PORT=9000

EXPOSE 9000
CMD ["npm", "run", "start"]
