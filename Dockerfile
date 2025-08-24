# Use Node 20 on Alpine
FROM node:20-alpine

# Prisma needs these on Alpine
RUN apk add --no-cache openssl libc6-compat

WORKDIR /app

# Copy only package files first to leverage Docker layer cache
COPY package*.json ./

# Install ALL deps (incl. dev) because prisma CLI is a devDependency
# If you only install prod deps, migrate/generate will fail in release_command
RUN npm ci

# Copy Prisma schema before generate/build
COPY prisma ./prisma

# Generate Prisma client now (so it's baked into the image)
RUN npx prisma generate

# Copy the rest of the source
COPY tsconfig.json ./
COPY src ./src

# Build TS -> dist
RUN npm run build

# Expose the app port (for docs; Fly routes regardless)
EXPOSE 5555

# Start the server (must match your package.json "start": "node dist/server.js")
CMD ["npm", "start"]
