# Test Scripts

This directory contains useful scripts for testing and working with OrchaLite.

## Available Scripts

### test-workflows.sh

A collection of curl commands to test different workflow scenarios:

1. **GitHub Repo Analysis**
   - Fetches 100 repos from GitHub
   - Filters repos with 1000+ stars
   - Stores results in default collection

2. **Microsoft Repo Analysis**
   - Fetches 50 repos from Microsoft
   - Filters repos with 5000+ stars
   - Stores results in 'microsoft-repos' collection

3. **Validation Error Test**
   - Tests the validation system with an invalid workflow
   - Missing required fields

4. **Dependency Error Test**
   - Tests dependency resolution with a non-existent step
   - Demonstrates error handling

## Usage

Make the script executable:
```bash
chmod +x test-workflows.sh
```

Run all tests:
```bash
./test-workflows.sh
```

Run specific test (using grep):
```bash
# Run only GitHub repo analysis
./test-workflows.sh | grep -A 20 "Testing GitHub repo analysis"

# Run only validation tests
./test-workflows.sh | grep -A 20 "Testing validation error"
```

## Adding New Tests

To add new test cases:
1. Add your curl command to `test-workflows.sh`
2. Add a descriptive echo statement
3. Include comments explaining the test case
4. Update this README if necessary 