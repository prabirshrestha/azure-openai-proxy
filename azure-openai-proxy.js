#!/usr/bin/env node

const http = require("http");
const https = require("https");
const { exec } = require("child_process");
const util = require("util");
const fs = require("fs");
const path = require("path");
const execAsync = util.promisify(exec);
const fsPromises = fs.promises;

// Default configuration
const defaultConfig = {
  port: process.env.PORT || 3000,
  defaultEndpoint: process.env.AZURE_ENDPOINT,
  defaultApiVersion: "2024-08-01-preview",
  models: {
    "gpt-4o-mini": "gpt-4o-mini",
    "gpt-4o": "gpt-4o",
    "o3-mini": "o3-mini",
  },
};

// Load configuration from file
async function loadConfig() {
  try {
    const configPath = path.join(
      process.env.HOME || process.env.USERPROFILE,
      ".azure-openai-proxy.json",
    );
    const fileContent = await fsPromises.readFile(configPath, "utf8");
    const fileConfig = JSON.parse(fileContent);

    // Merge configurations
    return {
      ...defaultConfig,
      ...fileConfig,
      port: process.env.PORT || fileConfig.port || defaultConfig.port,
      defaultEndpoint:
        process.env.AZURE_ENDPOINT ||
        fileConfig.defaultEndpoint ||
        defaultConfig.defaultEndpoint,
    };
  } catch (error) {
    console.log("Using default configuration (no valid config file found)");
    return defaultConfig;
  }
}

const TOKEN_REFRESH_BUFFER = 10 * 60; // 10 minutes in seconds

async function getAzureToken() {
  try {
    const { stdout } = await execAsync(
      "az account get-access-token --resource https://cognitiveservices.azure.com",
    );
    const { accessToken, expires_on } = JSON.parse(stdout);
    return { token: accessToken, expiresOn: parseInt(expires_on) };
  } catch (error) {
    console.error("Error getting Azure token:", error);
    throw new Error("Failed to get Azure access token");
  }
}

let tokenCache = {
  token: null,
  expiresOn: 0,
};

async function getAuthToken() {
  const now = Math.floor(Date.now() / 1000);
  const tokenExpirationBuffer = now + TOKEN_REFRESH_BUFFER;

  // Check if token is missing or will expire within the buffer time
  if (!tokenCache.token || tokenExpirationBuffer >= tokenCache.expiresOn) {
    console.log("Fetching new Azure token due to expiration or missing token");
    const newToken = await getAzureToken();
    tokenCache = newToken;
  }
  return tokenCache.token;
}

function parseRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function streamResponse(azureUrl, requestBody, authToken, res) {
  const url = new URL(azureUrl);

  const options = {
    hostname: url.hostname,
    path: url.pathname + url.search,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${authToken}`,
    },
  };

  const azureReq = https.request(options, (azureRes) => {
    if (azureRes.statusCode !== 200) {
      let errorData = "";
      azureRes.on("data", (chunk) => {
        errorData += chunk;
      });
      azureRes.on("end", () => {
        res.writeHead(azureRes.statusCode, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers":
            "Content-Type, Authorization, x-stainless-timeout",
        });
        res.end(errorData);
      });
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers":
        "Content-Type, Authorization, x-stainless-timeout",
    });

    azureRes.on("data", (chunk) => {
      res.write(chunk);
    });

    azureRes.on("end", () => {
      res.end();
    });
  });

  azureReq.on("error", (error) => {
    console.error("Error streaming from Azure:", error);
    res.writeHead(500, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers":
        "Content-Type, Authorization, x-stainless-timeout",
    });
    res.end(JSON.stringify({ error: "Streaming error occurred" }));
  });

  azureReq.write(JSON.stringify(requestBody));
  azureReq.end();
}

async function makeRegularRequest(azureUrl, requestBody, authToken) {
  const url = new URL(azureUrl);

  const options = {
    hostname: url.hostname,
    path: url.pathname + url.search,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${authToken}`,
    },
  };

  return new Promise((resolve, reject) => {
    const azureReq = https.request(options, (azureRes) => {
      let data = "";
      azureRes.on("data", (chunk) => {
        data += chunk;
      });
      azureRes.on("end", () => {
        resolve({
          status: azureRes.statusCode,
          headers: azureRes.headers,
          data: JSON.parse(data),
        });
      });
    });

    azureReq.on("error", reject);
    azureReq.write(JSON.stringify(requestBody));
    azureReq.end();
  });
}

const CORS_ALLOWED_HEADERS = "*";

// Function to resolve model configuration
function resolveModelConfig(model, config) {
  const modelConfig = config.models[model];

  if (!modelConfig) {
    return null;
  }

  // If modelConfig is a string, it's just the deployment name
  if (typeof modelConfig === "string") {
    return {
      deployment: modelConfig,
      endpoint: config.defaultEndpoint,
      apiVersion: config.defaultApiVersion,
      modelName: null, // No model name override
    };
  }

  // Otherwise, it's an object with potentially custom endpoint, apiVersion, and modelName
  return {
    deployment: modelConfig.deployment,
    endpoint: modelConfig.endpoint || config.defaultEndpoint,
    apiVersion: modelConfig.apiVersion || config.defaultApiVersion,
    modelName: modelConfig.modelName || null, // Include modelName if present
  };
}

async function startServer() {
  // Load configuration
  const config = await loadConfig();

  const server = http.createServer(async (req, res) => {
    try {
      console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);

      // Handle CORS preflight requests
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": CORS_ALLOWED_HEADERS,
          "Access-Control-Max-Age": "86400", // 24 hours
        });
        res.end();
        return;
      }

      // Handle chat completions
      if (req.method === "POST" && req.url === "/v1/chat/completions") {
        const requestBody = await parseRequestBody(req);
        const model = requestBody.model;
        const modelConfig = resolveModelConfig(model, config);

        if (!modelConfig) {
          res.writeHead(400, {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": CORS_ALLOWED_HEADERS,
          });
          res.end(JSON.stringify({ error: `Model ${model} not configured` }));
          return;
        }

        const authToken = await getAuthToken();
        const isStreaming = requestBody.stream === true;
        const azureUrl = `${modelConfig.endpoint}/openai/deployments/${modelConfig.deployment}/chat/completions?api-version=${modelConfig.apiVersion}`;

        console.log(`Routing to: ${azureUrl}`);

        if (modelConfig.modelName) {
          requestBody = { ...requestBody, model: modelConfig.modelName };
          console.log(`Using model override: ${modelConfig.modelName}`);
        }

        if (isStreaming) {
          await streamResponse(azureUrl, requestBody, authToken, res);
        } else {
          const response = await makeRegularRequest(
            azureUrl,
            requestBody,
            authToken,
          );
          res.writeHead(response.status, {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": CORS_ALLOWED_HEADERS,
          });
          res.end(JSON.stringify(response.data));
        }

        return;
      }

      // Handle embeddings
      if (req.method === "POST" && req.url === "/v1/embeddings") {
        const requestBody = await parseRequestBody(req);
        const model = requestBody.model;
        const modelConfig = resolveModelConfig(model, config);

        if (!modelConfig) {
          res.writeHead(400, {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": CORS_ALLOWED_HEADERS,
          });
          res.end(JSON.stringify({ error: `Model ${model} not configured` }));
          return;
        }

        const authToken = await getAuthToken();
        const azureUrl = `${modelConfig.endpoint}/openai/deployments/${modelConfig.deployment}/embeddings?api-version=${modelConfig.apiVersion}`;

        console.log(`Routing to: ${azureUrl}`);

        if (modelConfig.modelName) {
          requestBody = { ...requestBody, model: modelConfig.modelName };
          console.log(`Using model override: ${modelConfig.modelName}`);
        }

        const response = await makeRegularRequest(
          azureUrl,
          requestBody,
          authToken,
        );
        res.writeHead(response.status, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": CORS_ALLOWED_HEADERS,
        });
        res.end(JSON.stringify(response.data));
        return;
      }

      if (req.method === "GET" && req.url === "/v1/models") {
        // Transform config.models into OpenAI-like format
        const models = Object.keys(config.models).map((id) => ({
          id,
          object: "model",
          created: Date.now(),
          owned_by: "azure",
        }));

        const response = {
          object: "list",
          data: models,
        };

        res.writeHead(200, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": CORS_ALLOWED_HEADERS,
        });
        res.end(JSON.stringify(response));
        return;
      }

      // Handle 404
      res.writeHead(404, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      });
      res.end(JSON.stringify({ error: "Not found" }));
    } catch (error) {
      console.error("Error processing request:", error);
      res.writeHead(500, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": CORS_ALLOWED_HEADERS,
      });
      res.end(JSON.stringify({ error: "Internal server error" }));
    }
  });

  server.listen(config.port, () => {
    console.log(
      `Proxy server running on port ${config.port} with CORS enabled for all origins`,
    );
    console.log(
      `Loaded configuration with ${Object.keys(config.models).length} models`,
    );
    console.log(`Default endpoint: ${config.defaultEndpoint}`);
    console.log(`Default API version: ${config.defaultApiVersion}`);
    console.log("Model mappings:");
    for (const [modelName, modelConfig] of Object.entries(config.models)) {
      if (typeof modelConfig === "string") {
        console.log(
          `  "${modelName}" → "${modelConfig}" (using default endpoint: ${config.defaultEndpoint})`,
        );
      } else {
        const modelNameInfo = modelConfig.modelName
          ? ` as "${modelConfig.modelName}"`
          : "";
        console.log(
          `  "${modelName}" → "${modelConfig.deployment}"${modelNameInfo} (endpoint: ${modelConfig.endpoint || config.defaultEndpoint})`,
        );
      }
    }
  });
}

// Start the server
startServer();
