# Stock-AI Web Dashboard

Static frontend for the Stock-AI recovery analysis dashboard. It is deployed to the S3 bucket `stock-ai-s3-web-page` in `us-east-1` by GitHub Actions.

## Repository layout

```text
stock-ai-web-ui/
├── .github/workflows/deploy.yml  # GitHub Actions → AWS S3 deployment
├── site/
│   ├── index.html                # Dashboard application
│   └── assets/dashboard-preview.png
└── README.md
```

## Dashboard behaviour

- **Before 4:00 PM IST:** today's prediction view is the primary view.
- **At/after 4:00 PM IST:** today's prediction review becomes the primary view.
- **Next Trading Day:** static `Coming soon` placeholder. It does not request a watchlist object.
- **Refreshed Predictions (7 AM):** static `Coming soon` placeholder until its future Lambda is available.
- The dashboard selects the newest `stock_ai_report.json` dated on or before today in IST and clearly displays its session date when it is not today. It reads `evaluation.json` and `stock_analysis_dataset.json` from that same date when present; it does not mix dates.
- Finding the latest report requires listing the results bucket. Missing reports are different from access, CORS, network, or invalid-data errors, which are shown on the dashboard.

## 1. Create/configure the website bucket

The bucket must be in `us-east-1` and have static website hosting enabled. Run from an AWS CLI profile with permission to configure the bucket:

```bash
aws s3api put-bucket-website \
  --bucket stock-ai-s3-web-page \
  --website-configuration '{"IndexDocument":{"Suffix":"index.html"},"ErrorDocument":{"Key":"index.html"}}' \
  --region us-east-1
```

For direct S3 website endpoint access, the site objects must be publicly readable. If using this approach, turn off **Block all public access** for this website bucket, then apply this bucket policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PublicReadWebsiteFiles",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::stock-ai-s3-web-page/*"
    }
  ]
}
```

Keep public access blocked if you put CloudFront in front of a private S3 origin using Origin Access Control (recommended for HTTPS and production use). The S3 website endpoint itself supports HTTP only.

## 2. Create an IAM role for GitHub Actions (OIDC)

Use GitHub OIDC instead of storing AWS access keys in GitHub.

### GitHub OIDC provider

In IAM, create an OpenID Connect identity provider if one does not already exist:

- Provider URL: `https://token.actions.githubusercontent.com`
- Audience: `sts.amazonaws.com`

### Role trust policy

Create an IAM role for web identity and use this trust policy. Replace `YOUR_GITHUB_ORG` and `YOUR_REPOSITORY` with the actual GitHub owner/org and repository name.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::017118229810:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": "repo:YOUR_GITHUB_ORG/YOUR_REPOSITORY:ref:refs/heads/main"
        }
      }
    }
  ]
}
```

### Role permissions policy

Attach this inline policy to the role. It allows deployment only to this website bucket.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ListWebsiteBucket",
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": "arn:aws:s3:::stock-ai-s3-web-page"
    },
    {
      "Sid": "ManageWebsiteObjects",
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::stock-ai-s3-web-page/*"
    }
  ]
}
```

Copy the role ARN after creating it.

## 3. Add the GitHub secret

In the GitHub repository, open **Settings → Secrets and variables → Actions → New repository secret**:

- Name: `AWS_ROLE_ARN`
- Value: the IAM role ARN created above, for example `arn:aws:iam::017118229810:role/GitHubActionsStockAIWebDeploy` (use your actual role ARN).

No AWS access key or secret access key is needed.

## 4. Deploy

1. Push this repository to GitHub, using `main` as the default branch.
2. Add the `AWS_ROLE_ARN` repository secret.
3. Push a change under `site/`, or manually run **Actions → Deploy Stock-AI UI to S3 → Run workflow**.
4. Check the workflow run. It syncs `site/` to the bucket root and removes deleted site files (`--delete`).

The website endpoint is:

```text
http://stock-ai-s3-web-page.s3-website-us-east-1.amazonaws.com
```

## 5. Allow the browser to read the existing results bucket

The dashboard lists and fetches JSON from `saravanesh-stock-ai-results`. The public S3 setup below exposes **all object names** in that bucket and allows anyone to read the three named JSON files. Use it only when that exposure is acceptable; otherwise use a secured API or a separately maintained public manifest instead.

Add these statements to the existing results bucket policy (retain any other statements you need). Public bucket policies also require appropriate bucket- and account-level Block Public Access settings.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PublicListResults",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::saravanesh-stock-ai-results"
    },
    {
      "Sid": "PublicReadDashboardJson",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": [
        "arn:aws:s3:::saravanesh-stock-ai-results/*/*/*/stock_ai_report.json",
        "arn:aws:s3:::saravanesh-stock-ai-results/*/*/*/evaluation.json",
        "arn:aws:s3:::saravanesh-stock-ai-results/*/*/*/stock_analysis_dataset.json"
      ]
    }
  ]
}
```

In the results bucket's CORS configuration, allow the actual website origin, for example:

```json
[
  {
    "AllowedHeaders": ["*"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedOrigins": ["http://stock-ai-s3-web-page.s3-website-us-east-1.amazonaws.com"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3000
  }
]
```

Add any other origins you actually use, such as a CloudFront or local-preview URL.

## Local preview

From the repository root:

```bash
python -m http.server 8000 --directory site
```

Open `http://localhost:8000`.

## Important

This is an experimental market-research dashboard, not investment advice. Keep the website bucket separate from the private results/data bucket. Do not commit AWS credentials, private market data, or secrets to this repository.
