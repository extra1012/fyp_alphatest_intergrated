FROM node:20-slim

# Set working directory
WORKDIR /usr/src/app

# Install dependencies
COPY package*.json ./
RUN npm install --production

# Copy app source
COPY . .

# Expose the port Cloud Run provides
ENV PORT=8080
EXPOSE 8080

# Start the server
CMD ["node", "server.js"]
