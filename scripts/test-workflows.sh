#!/bin/bash

# Test workflow for GitHub repo analysis
echo "Testing GitHub repo analysis workflow..."
curl -X POST http://localhost:3000/workflow/run \
     -H "Content-Type: application/json" \
     -d '{
       "name": "github-repo-analysis",
       "steps": [
         {
           "id": "fetch",
           "task": "fetchRepos",
           "params": { "org": "github", "perPage": 100 },
           "dependsOn": []
         },
         {
           "id": "filter",
           "task": "filterRepos",
           "params": { "minStars": 1000 },
           "dependsOn": ["fetch"]
         },
         {
           "id": "store",
           "task": "storeRepos",
           "dependsOn": ["filter"]
         }
       ]
     }'

echo -e "\n\nTest workflow for specific organization..."
curl -X POST http://localhost:3000/workflow/run \
     -H "Content-Type: application/json" \
     -d '{
       "name": "microsoft-repo-analysis",
       "steps": [
         {
           "id": "fetch",
           "task": "fetchRepos",
           "params": { "org": "microsoft", "perPage": 50 },
           "dependsOn": []
         },
         {
           "id": "filter",
           "task": "filterRepos",
           "params": { "minStars": 5000 },
           "dependsOn": ["fetch"]
         },
         {
           "id": "store",
           "task": "storeRepos",
           "params": { "collectionName": "microsoft-repos" },
           "dependsOn": ["filter"]
         }
       ]
     }'

# Example of a workflow with validation error (missing required field)
echo -e "\n\nTesting validation error..."
curl -X POST http://localhost:3000/workflow/run \
     -H "Content-Type: application/json" \
     -d '{
       "name": "invalid-workflow",
       "steps": [
         {
           "id": "fetch",
           "task": "fetchRepos",
           "dependsOn": []
         }
       ]
     }'

# Example of a workflow with dependency error
echo -e "\n\nTesting dependency error..."
curl -X POST http://localhost:3000/workflow/run \
     -H "Content-Type: application/json" \
     -d '{
       "name": "dependency-error",
       "steps": [
         {
           "id": "filter",
           "task": "filterRepos",
           "params": { "minStars": 1000 },
           "dependsOn": ["nonexistent-step"]
         }
       ]
     }' 