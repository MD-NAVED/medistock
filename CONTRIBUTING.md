# Contributing to MediStock

Thank you for your interest in contributing to **MediStock**! We welcome contributions from developers, healthcare technologists, and clinical operations professionals.

MediStock is an open-source clinical pharmacy and inventory system. To maintain code reliability, patient safety standards, and multi-tenant isolation, please follow these guidelines.

---

## 📌 Code of Conduct

* Be respectful, inclusive, and professional in all communications.
* Treat clinical safety, data isolation, and user experience with top priority.

---

## 🐛 Reporting Issues & Feature Requests

### Reporting Bugs
1. **Search existing issues**: Before creating a new issue, check the [Issue Tracker](https://github.com/MD-NAVED/medistock/issues) to ensure it has not already been reported.
2. **Use a descriptive title**: Briefly describe the problem and the affected component (e.g., `[POS] FEFO allocation deducts incorrect batch on fractional return`).
3. **Provide reproduction steps**:
   * Expected behavior vs. actual behavior.
   * Minimal steps to reproduce the bug.
   * Environment details: Browser, Node.js version, OS, or Android APK version.
   * Relevant logs or screenshots (ensure no sensitive patient or financial data is exposed).

### Suggesting Enhancements & Feature Requests
* Clearly explain the clinical or business use case.
* Detail why existing workflows do not address the problem.
* Propose an architectural or UI approach if applicable.

---

## 🌿 Git Branching Conventions

When creating branches, use the following naming convention:

| Prefix | Description | Example |
| :--- | :--- | :--- |
| `feat/` | New features or clinical capabilities | `feat/hl7-fhir-r4-sync` |
| `fix/` | Bug fixes and patches | `fix/fefo-batch-sorting` |
| `docs/` | Documentation improvements | `docs/architecture-overview` |
| `perf/` | Performance optimizations | `perf/swr-cache-reports` |
| `refactor/`| Code refactoring without behavioral change | `refactor/session-storage-pool` |
| `chore/` | Tooling, dependency, or CI/CD updates | `chore/bump-capacitor-android` |

---

## 🛠️ Development & PR Workflow

### 1. Fork & Clone
Fork the repository on GitHub and clone your fork locally:
```bash
git clone https://github.com/<your-username>/medistock.git
cd medistock
```

### 2. Set Up Environment
```bash
# Install root, server, and client dependencies
npm run setup

# Copy sample environment configuration
cp .env.example .env
```
Configure your `.env` with a local PostgreSQL or free Supabase instance.

### 3. Create a Feature Branch
```bash
git checkout -b feat/your-feature-name
```

### 4. Code Standards & Testing
* **Test Suite**: Always run the automated test suite before opening a PR:
  ```bash
  npm test
  ```
  Ensure all test suites pass without errors.
* **Security & Multi-Tenancy**: All database queries must respect `store_id` tenant scoping and PostgreSQL Row Level Security (RLS). Never expose raw credentials, tokens, or unhashed secrets.
* **Clean Commits**: Write clear, imperative commit messages (e.g., `feat(billing): add auto FEFO batch allocation`).

### 5. Submit a Pull Request
1. Push your branch to your GitHub fork:
   ```bash
   git push origin feat/your-feature-name
   ```
2. Open a Pull Request against the `main` branch of `MD-NAVED/medistock`.
3. Provide a clear PR description detailing:
   * Summary of changes.
   * Motivation & context.
   * How you tested your changes.
   * Any linked issue tickets (e.g., `Closes #12`).

---

## 📜 License
By contributing to MediStock, you agree that your contributions will be licensed under the project's [MIT License](LICENSE).
