/**
 * 会議スコープのセマンティック埋め込みを生成する (public/embeddings.json)。
 *
 * Ported from scripts/embeddings.py.  The Python original used fastembed; the
 * Node version uses @huggingface/transformers with the same model
 * (all-MiniLM-L6-v2), which is also what the browser side loads — one runtime
 * for both generator and consumer.
 *
 * 使い方:
 *   node src/embeddings.ts public/data.json public/embeddings.json
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type FeatureExtractionPipeline, pipeline } from "@huggingface/transformers";

export const EMBEDDING_MODEL = "sentence-transformers/all-MiniLM-L6-v2";
export const EMBEDDING_MULTI_MODEL = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
export const EMBEDDING_DIM = 384;

const extractorPromises = new Map<string, Promise<FeatureExtractionPipeline>>();

function getExtractor(model: string): Promise<FeatureExtractionPipeline> {
  let p = extractorPromises.get(model);
  if (!p) {
    p = pipeline("feature-extraction", model) as Promise<FeatureExtractionPipeline>;
    extractorPromises.set(model, p);
  }
  return p;
}

/** Round to 6 decimal places like Python's round(float(x), 6). */
function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

/** 日本語会議（情報処理学会・電子情報通信学会の研究会・特集号等）のプロファイルに
 * 付与する日本語の分野キーワード。多言語モデル用のみ（英語モデルには使わない）。
 * 実測（日本語ベンチ A/B）: これらを付与すると国内研究会のセマンティック検索が
 * top1 8.3%→25.0%・top5 16.7%→50.0% に改善（クエリの日本語語彙が会議に届く）。 */
const JP_CAT_KW: Record<string, string> = {
  systems:
    "カーネル スケジューリング 仮想化 オペレーティングシステム ミドルウェア ストレージ リアルタイム 組み込み メモリ",
  networking: "ネットワーク 通信 ルーティング 無線 プロトコル トラフィック",
  hpc: "ハイパフォーマンス スーパーコンピュータ 並列 GPU MPI",
  ai: "機械学習 深層学習 ニューラル 生成 推論",
  security: "セキュリティ プライバシー 暗号 認証",
  db: "データベース データマイニング 検索",
  graphics: "グラフィックス 可視化 映像 画像 レンダリング",
  hci: "ヒューマン ユーザインタフェース ユーザビリティ インタラクション",
  theory: "アルゴリズム 計算量 複雑性 グラフ",
};

function hasJapanese(text: string): boolean {
  return /[\u3040-\u9fff]/.test(text);
}

/** 会議のセマンティックプロファイルを実採択論文タイトルで強化する（R12）。
 * 会議名（International Conference on Machine Learning 等）だけでは実論文タイトル
 * （Batched Dueling Bandits 等）に似ず、実論文での正解会議が top5 に入らない
 * （golden EN 実測: top1 0.0%）ことが発端。代表論文タイトルをプロファイルに混ぜると
 * 「会議の実際の採択領域」を埋め込みに反映できる。
 *
 * データ源: 公式採択リスト（SOSP '25 sigops.org / NDSS '25 / ICML PMLR）。
 * bench の golden EN テストセット（GOLDEN_EN, src/bench-recommender.ts）とは
 * **完全に重複しないタイトルだけを使う**（リークなし検証）。
 */
export const VENUE_PAPERS: Record<string, string[]> = {
  sosp: [
    "Pesto: Cooking up High Performance BFT Queries",
    "How to Copy Memory? Coordinated Asynchronous Copy as a First-Class OS Service",
    "Moirai: Optimizing Placement of Data and Compute in Hybrid Clouds",
    "Unlocking True Elasticity for the Cloud-Native Era with Dandelion",
    "Spirit: Fair Allocation of Interdependent Resources in Remote Memory Systems",
    "HedraRAG: Co-Optimizing Generation and Retrieval for Heterogeneous RAG Workflows",
    "Supporting POSIX fork Within a Single-Address-Space OS",
    "DiffKV: Differentiated Memory Management for Large Language Models with Parallel KV Compaction",
    "Oasis: Pooling PCIe Devices Over CXL to Boost Utilization",
    "Concurrent OS-level GPU Checkpoint and Restore with Validated Speculation",
    "A Programmable Serving System for Emerging LLM Applications",
    "Aegaeon: Effective GPU Pooling for Concurrent LLM Serving on the Market",
    "Aeolia: A Fast and Secure Userspace Interrupt-Based Storage Stack",
    "cache_ext: Customizing the Page Cache with eBPF",
    "Atmosphere: Practical Verified Kernels with Rust and Verus",
    "Jenga: Effective Memory Management for Serving LLM with Heterogeneity",
    "IC-Cache: Efficient Large Language Model Serving via In-context Caching",
    "Managing Scalable Direct Storage Accesses for GPUs",
    "KTransformers: Unleashing the Full Potential of CPU/GPU Hybrid Inference for MoE Models",
    "Coyote v2: Raising the Level of Abstraction for Data Center FPGAs",
  ],
  eurosys: [
    // R23: EuroSys '25（dblp eurosys2025、85 本。GOLDEN_EN の 7 本と完全分離 = リークなし）
    "Chrono: Meticulous Hotness Measurement and Flexible Page Migration for Memory Tiering",
    "Deft: A Scalable Tree Index for Disaggregated Memory",
    "Daredevil: Rescue Your Flash Storage from Inflexible Kernel Storage Stack",
    "Towards Efficient Flash Caches with Emerging NVMe Flexible Data Placement SSDs",
    "Pegasus: Transparent and Unified Kernel-Bypass Networking for Fast Local and Remote Communication",
    "Byte vSwitch: A High-Performance Virtual Switch for Cloud Networking",
    "Enabling Virtual Priority in Data Center Congestion Control",
    "CacheBlend: Fast Large Language Model Serving for RAG with Cached Knowledge Fusion",
    "SpInfer: Leveraging Low-Level Sparsity for Efficient Large Language Model Inference on GPUs",
    "Multi-Grained Specifications for Distributed System Model Checking and Verification",
    "Ladon: High-Performance Multi-BFT Consensus via Dynamic Global Ordering",
    "Rakis: Secure Fast I/O Primitives Across Trust Boundaries on Intel SGX",
  ],
  ppopp: [
    // R24: PPoPP '25（dblp ppopp2025、50 本。GOLDEN_EN の 7 本と完全分離 = リークなし）
    "Helios: Efficient Distributed Dynamic Graph Sampling for Online GNN Inference",
    "RT-BarnesHut: Accelerating Barnes-Hut Using Ray-Tracing Hardware",
    "EVeREST: An Effective and Versatile Runtime Energy Saving Tool for GPUs",
    "Fairer and More Scalable Reader-Writer Locks by Optimizing Queue Management",
    "Setting a Course for Post-Moore Software Performance",
    "Big Atomics and Fast Hash Tables",
    "Boost Lock-free Queue and Stack with Batching",
    "FlashSparse: Minimizing Computation Redundancy for Fast Sparse Matrix Multiplications on Tensor Cores",
    "Triangle Counting on Tensor Cores",
    "Mario: Near Zero-cost Activation Checkpointing in Pipeline Parallelism",
    "MARLIN: Mixed-Precision Auto-Regressive Parallel Inference on Large Language Models",
    "Harnessing Inter-GPU Shared Memory for Seamless MoE Communication-Computation Fusion",
  ],
  sigcomm: [
    // R26: SIGCOMM '25（dblp sigcomm2025、88 本。GOLDEN_EN の 7 本と完全分離 = リークなし）
    "LeoCC: Making Internet Congestion Control Robust to LEO Satellite Dynamics",
    "Falcon: A Reliable, Low Latency Hardware Transport",
    "Inter-domain Routing with Extensible Criteria",
    "InfiniteHBD: Building Datacenter-Scale High-Bandwidth Domain for LLM with Optical Circuit Switching Transceivers",
    "Revisiting RDMA Reliability for Lossy Fabrics",
    "ByteDance Jakiro: Enabling RDMA and TCP over Virtual Private Cloud",
    "SGLB: Scalable and Robust Global Load Balancing in Commodity AI Clusters",
    "Albatross: A Containerized Cloud Gateway Platform with FPGA-accelerated Packet-level Load Balancing",
    "Centralium: A Hybrid Route-Planning Framework for Large-Scale Data Center Network Migrations",
    "DeepSpace: Super Resolution Powered Efficient and Reliable Satellite Image Data Acquistion",
    "Edge Caching as Differentiation",
    "Towards User-level QoE: Large-scale Practice in Personalized Optimization of Adaptive Video Streaming",
  ],
  ndss: [
    "A Method to Facilitate Membership Inference Attacks in Deep Learning Models",
    "A Large-Scale Measurement Study of the PROXY Protocol and its Security Implications",
    "A Multifaceted Study on the Use of TLS and Auto-detect in Email Ecosystems",
    "An Empirical Study on Fingerprint API Misuse with Lifecycle Analysis in Real-world Android Apps",
    "ASGARD: Protecting On-Device Deep Neural Networks with Virtualization-Based Trusted Execution Environments",
    "Automatic Insecurity: Exploring Email Auto-configuration in the Wild",
    "Be Careful of What You Embed: Demystifying OLE Vulnerabilities",
    "Beyond Classification: Inferring Function Names in Stripped Binaries via Domain Adapted LLMs",
    "BinEnhance: An Enhancement Framework Based on External Environment Semantics for Binary Code Search",
    "BitShield: Defending Against Bit-Flip Attacks on DNN Executables",
    "Blackbox Fuzzing of Distributed Systems with Multi-Dimensional Inputs and Symmetry-Based Feedback Pruning",
    "Blindfold: Confidential Memory Management by Untrusted Operating System",
    "Cascading Spy Sheets: Exploiting the Complexity of Modern CSS for Email and Browser Fingerprinting",
    "CHAOS: Exploiting Station Time Synchronization in 802.11 Networks",
    "CENSOR: Defense Against Gradient Inversion via Orthogonal Subspace Bayesian Sampling",
    "CLIBE: Detecting Dynamic Backdoors in Transformer-based NLP Models",
    "Compiled Models, Built-In Exploits: Uncovering Pervasive Bit-Flip Attack Surfaces in DNN Executables",
    // R22: ndss golden 失敗 4 件（BULKHEAD/Bootloaders/Side Channels/Alba）対策。
    // NDSS '25 実採択で GOLDEN_EN に無いものだけ追加（dblp ndss2025 確認 2026-08-12）。
    "TME-Box: Scalable In-Process Isolation through Intel TME-MK Memory Encryption",
    "KernelSnitch: Side Channel-Attacks on Kernel Data Structures",
    "Kronos: A Secure and Generic Sharding Blockchain Consensus with Optimized Overhead",
    "Manifoldchain: Maximizing Blockchain Throughput via Bandwidth-Clustered Sharding",
  ],
  nsdi: [
    "Holmes: Localizing Irregularities in LLM Training with Mega-scale GPU Clusters",
    "Evolution of Aegis: Fault Diagnosis for AI Model Training Cloud Service in Production",
    "SimAI: Unifying Architecture Design and Performance Tuning for Large-Scale Large Language Model Training",
    "Optimizing RLHF Training for Large Language Models with Stage Fusion",
    "BCP: A Unified Checkpointing System for Large Foundation Model Development",
    "GPU-Disaggregated Serving for Deep Learning Recommendation Models at Scale",
    "SuperServe: Fine-Grained Inference Serving for Unpredictable Workloads",
    "OptiReduce: Resilient and Tail-Optimal AllReduce for Distributed Deep Learning in the Cloud",
    "White-Boxing RDMA with Packet-Granular Software Control",
    "ONCache: A Cache-Based Low-Overhead Container Overlay Network",
    "Preventing Network Bottlenecks: Accelerating Datacenter Services with Hotspot-Aware Placement for Compute and Storage",
    "Quicksand: Harnessing Stranded Datacenter Resources with Granular Computing",
    "Making Serverless Pay-For-Use a Reality with Leopard",
    "Eden: Developer-Friendly Application-Integrated Far Memory",
    "Mowgli: A Passive Approach to Learning Real-Time Rate Control for Video Conferencing",
    "Efficient Direct-Connect Topologies for Collective Communications",
  ],
  osdi: [
    "ZEN: Empowering Distributed Training with Sparsity-driven Data Synchronization",
    "Understanding Stragglers in Large Model Training Using What-if Analysis",
    "Training with Confidence: Catching Silent Errors in Deep Learning Training with Automated Proactive Checks",
    "BlitzScale: Fast and Live Large Model Autoscaling with O(1) Host Caching",
    "DecDEC: A Systems Approach to Advancing Low-Bit LLM Quantization",
    "KPerfIR: Towards an Open and Compiler-centric Ecosystem for GPU Kernel Performance Tooling",
    "PipeThreader: Software-Defined Pipelining for Efficient DNN Execution",
    "Neutrino: Fine-grained GPU Kernel Profiling via Programmable Probing",
    "Enabling Efficient GPU Communication over Multiple NICs with FuseLink",
    "Decouple and Decompose: Scaling Resource Allocation with DeDe",
    "Kamino: Efficient VM Allocation at Scale with Latency-Driven Cache-Aware Scheduling",
    "Fork in the Road: Reflections and Optimizations for Cold Start Latency in Production Serverless Systems",
    "Tigon: A Distributed Database for a CXL Pod",
    "XQueue: Preemptive Scheduling for Diverse XPUs using Multi-level Hardware Model",
    // R19: QiMeng（transcompiling tensor programs）対策。OSDI '25 採択（公式 program 確認）。
    // Mirage は GOLDEN_EN に既存のためリーク — 追加しない（テストで検出）。
    "Bayesian Code Diffusion for Efficient Automatic Deep Learning Program Optimization",
    // R22: Quake（vector search）対策。OSDI '25 採択で GOLDEN_EN に無い 1 本
    // （"Achieving Low-Latency Graph-Based Vector Search via Aligning
    // Best-First Search Algorithm with SSD"、dblp osdi2025 確認 2026-08-12）。
    // Quake 自身は GOLDEN_EN 側のためリーク — 追加しない。
    "Achieving Low-Latency Graph-Based Vector Search via Aligning Best-First Search Algorithm with SSD",
  ],
  rtss: [
    "Probabilistic Response-Time-Aware Search for Transient Astrophysical Phenomena",
    "Reducing Worst-Case Deadline Failure Probability for EDF Scheduling",
    "Response Time Analysis for Probabilistic DAG Tasks in Multicore Real-Time Systems",
    "ROSRT: Enabling Flexible Scheduling in ROS 2",
    "Partitioning Kernel with Capability Controlled Temporal and Spatial Partitioning",
    "Jitter Propagation in Task Chains",
    "Faster, Exact, More General Response-time Analysis for NVIDIA Holoscan Applications",
    "A Soft-Real-Time Optimal Scheduler for DAG Tasks with Node-Level Self Dependencies",
    "Recursive Partitioned Scheduling for Real-Time Gang Tasks",
    "Formal Timing Analysis of CQF Interference in TSN: A Network Calculus-Based Approach",
    "Lyapunov-Based Stability and Delay Bounds for IEEE 802.1Qbv in Imperfectly Synchronized TSN",
    "Real-Time Multitasking of Deep Neural Networks with Nvidia TensorRT",
    "Nova: Real-Time Agentic Vision-Language Model Serving with Adaptive Cross-Stage Parallelization",
    "DERCA: DetERministic Cycle-Level Accelerator on Reconfigurable Platforms in DNN-Enabled Real-Time Safety-Critical Systems",
    "Dynamic Fuzzing-Based Whole-System Timing Analysis",
    "Modern LLVM-based Compiler Autotuning for WCET Optimization",
    "Exploiting Burstiness to Improve Multi-Core Interference Analysis",
    "Tight Cache Contention Analysis for WCET Estimation on Multicore Systems",
    "MemScope: Open-Source Kernel-Level Framework for Heterogeneous Memory Characterization",
    "TSI: A Time-semantic Instruction Set for Deterministic Data-Flow Execution in Real-Time Embedded Systems",
    "Requirement-Based Analysis of Self-Suspending Tasks under EDF",
    "LEFT-RS: A Lock-Free Fault-Tolerant Resource Sharing Protocol for Multicore Real-Time Systems",
  ],
  rtas: [
    "Asymptotically Optimal Multiprocessor Real-Time Locking for non-JLFP Scheduling",
    "SPR: Shielded Processor Reservations with Bounded Management Overhead",
    "Nip it in the Bud: Job Acceptance Multi-Server",
    "Optimal Priority Assignment for Synchronous Harmonic Tasks with Dynamic Self-Suspension",
    "A Unified Framework for Quantitative Cache Analysis",
    "Consistency-Aware and Predictable Memory Processing for Safety-Critical Out-of-Order Multicores",
    "ParRP: Enabling Space Isolation in Caches with Shared Data",
    "A Field Practical Approach to Memory Bandwidth Allocation for Consolidating Multi-Domain Automotive Applications on a Single SoC",
    "Intelligent Power Distribution Systems: Model, Utilization Bounds, and Implementation",
    "Mesh Network Scheduling Based on Cyber-Physical Sensitivity for Wireless Control Systems",
    "Analysis of Control Systems Under Sensor Timing Misalignments",
    "Scheduling Ev Battery Swap/Charge Operations",
    "Optimal Task Phasing for End-To-End Latency in Harmonic and Semi-Harmonic Automotive Systems",
    "Reconciling ROS 2 with Classical Real-Time Scheduling of Periodic Tasks",
    "Jointly Ensuring Timing Disparity and End-to-End Latency Constraints in Hybrid DAGs",
    "Integrated Real-Time Control and Scheduling for Safety Critical Cyber-Physical Systems",
    "Recovery-Guaranteed Sensor Attack Detection for Cyber-Physical Systems",
    "Scheduling Job Streams on Uniprocessors with Cold Start Delays",
    "MATCH: Real-Time Scheduling of Multiple and Parallel Data Copies in Heterogeneous Architectures",
    "Scheduling Processing Graphs of Gang Tasks on Heterogeneous Platforms",
    "Silverline: Lightweight Virtualization and Orchestration of Distributed Systems",
    "HARD: Hardening Real-Time Scheduling and Analysis for Accelerator Enabled Computing",
  ],
  ecrts: [
    "A First Look at ROS 2 Applications Written in Asynchronous Rust",
    "Multi-Objective Memory Bandwidth Regulation and Cache Partitioning for Multicore Real-Time Systems",
    "Enabling Containerisation of Distributed Applications with Real-Time Constraints",
    "RESCUE: Multi-Robot Planning Under Resource Uncertainty and Objective Criticality",
    "On Real-Time Guarantees in Intel SGX and TDX",
    "DAMA: A Dual Arbitration Mechanism for Mixed-Criticality Applications",
    "LoRaHART: Hardware-Aware Real-Time Scheduling for LoRa",
    "Bounding the WCET of a GPU Thread Block with a Multi-Phase Representation of Warps Execution",
    "Real-Time System Evaluation Techniques: A Systematic Mapping Study",
  ],
  icdcs: [
    "Spacker: Unified State Migration for Distributed Streaming",
    "LLMSched: Uncertainty-Aware Workload Scheduling for Compound LLM Applications",
    "Communication-Efficient MoE Fine-Tuning with Locality-Aware Expert Placement",
    "Shuffle-Exchange: Enhancing Collective Communication Efficiency for Large Model Training",
    "Efficient Serverless Cold Start: Reducing Library Loading Overhead by Profile-guided Optimization",
    "P4CEMaker: automated hardware acceleration of consensus protocols",
    "RAPIDSCRIBE: Bandwidth-aware Parallel Snapshots for Distributed Neural-Network Training",
    "GreenFL: Carbon-efficient Federated Learning over RE Powered Edge Computing Systems",
    "EquiBFT: A Framework for Achieving Fairness in BFT Consensus",
    "SOLB: Synchronization-Objective Load Balancing for Distributed DNN Training",
    "Mosaic: Client-driven Account Allocation Framework in Sharded Blockchains",
    "PEE: Precise ECN Encoding for Efficient Congestion Control in Data Center Networks",
    "Asynchronous Dynamic Committee Proactive Secret Sharing for Large Data",
    "Octopus: Decentralized Workflow-granular Scheduling for Serverless Workflow",
    "S2M3: Split-and-Share Multi-Modal Models for Distributed Multi-Task Inference on the Edge",
    "ECCheck: Enhancing In-Memory Checkpoint with Erasure Coding in Distributed DNN Training",
    "Mahi-Mahi: Low-Latency Asynchronous BFT DAG-Based Consensus",
    "FedLTH: A Privacy-preserving Federated Learning Framework with Model Pruning on Edge Clients",
    "Mast: Efficient Training of Mixture-of-Experts Transformers with Task Pipelining and Ordering",
    "Elastic Scheduling for Mix-Flow in Time-Sensitive Networking",
    // R22: icdcs golden 失敗 5 件（SGX/Ethereum/BEyes/InverCRS/Backdoor）対策。
    // いずれも ICDCS '25 実採択で GOLDEN_EN に無いものだけ追加（dblp icdcs2025 確認 2026-08-12）。
    "FLdetox: Detoxify Persistent Backdoors in Federated Learning",
    "A Client-level Assessment of Collaborative Backdoor Poisoning in Non-IID Federated Learning",
    "Enabling Bitcoin Smart Contracts on the Internet Computer",
    "Fully Decentralized Collection of Attestations for Single-Slot Finality in Ethereum",
    "Too Clever by Half: Detecting Sampling-based Model Stealing Attacks by Their Own Cleverness",
    // R22: SGX-Enabled（golden）の encrypted/secure 語彙を補う（privacy 1 本は usenix
    // top1 を奪うため除外。QuHE は Ethereum/privacy 語彙を持たず衝突しない）。
    "QuHE: Optimizing Utility-Cost in Quantum Key Distribution and Homomorphic Encryption Enabled Secure Edge Computing Networks",
  ],
  ches: [
    "FANNG-MPC: Framework for Artificial Neural Networks and Generic MPC",
    "TPUXtract: An Exhaustive Hyperparameter Extraction Framework",
    "Trace Copilot: Automatically Locating Cryptographic Operations in Side-Channel Traces by Firmware Binary Instrumenting",
    "FalconSign: An Efficient and High-Throughput Hardware Architecture for Falcon Signature Generation",
    "GPU Acceleration for FHEW/TFHE Bootstrapping",
    "TFHE Gets Real: An Efficient and Flexible Homomorphic Floating-Point Arithmetic",
    "KyberSlash: Exploiting Secret-Dependent Division Timings in Kyber Implementations",
    "CHERI-Crypt: Transparent Memory Encryption on Capability Architectures",
    "OPTIMSM: FPGA hardware accelerator for Zero-Knowledge MSM",
    "Constant time lattice reduction in dimension 4 with application to SQIsign",
    "AETHER: An Ultra-High Throughput and Low Energy Authenticated Encryption Scheme",
    "New Quantum Cryptanalysis of Binary Elliptic Curves",
    "POTA: A Pipelined Oblivious Transfer Acceleration Architecture for Secure Multi-Party Computation",
    "A5/3 make or break: A massively parallel FPGA architecture for exhaustive key search",
    "Adaptive Template Attacks on the Kyber Binomial Sampler",
    "SoK: FHE-Friendly Symmetric Ciphers and Transciphering",
    "Practical Opcode-based Fault Attack on AES-NI",
    "Accelerating NTT with RISC-V Vector Extension for Fully Homomorphic Encryption",
    "Fault Attacks on ECC Signature Verification",
    "FusionMSM: A Collision-Free and Arithmetic-Optimized FPGA-based Accelerator for Multi-Scalar Multiplication",
  ],
  "usenix-security": [
    "Breaking the Layer Barrier: Remodeling Private Transformer Inference with Hybrid CKKS and MPC",
    "Leuvenshtein: Efficient FHE-based Edit Distance Computation with Single Bootstrap per Cell",
    "Arbitrary-Threshold Fully Homomorphic Encryption with Lower Complexity",
    "Beyond Statistical Estimation: Differentially Private Individual Computation via Shuffling",
    "Voting-Bloc Entropy: A New Metric for DAO Decentralization",
    "DP-BREM: Differentially-Private and Byzantine-Robust Federated Learning with Client Momentum",
    "Refiner: Data Refining against Gradient Leakage Attacks in Federated Learning",
    "Boosting Gradient Leakage Attacks: Data Reconstruction in Realistic FL Settings",
    "Place Protections at the Right Place: Targeted Hardening for Cryptographic Code against Spectre v1",
    "TimeTravel: Real-time Timing Drift Attack on System Time Using Acoustic Waves",
    "BarraCUDA: Edge GPUs do Leak DNN Weights",
    "SoK: A Security Architect's View of Printed Circuit Board Attacks",
    "Self-interpreting Adversarial Images",
    "TwinBreak: Jailbreaking LLM Security Alignments based on Twin Prompts",
    "Dormant: Defending against Pose-driven Human Image Animation",
    "Whispering Under the Eaves: Protecting User Privacy Against Commercial and LLM-powered Automatic Speech Recognition Systems",
    "AUTOVR: Automated UI Exploration for Detecting Sensitive Data Flow Exposures in Virtual Reality Apps",
    "As Advertised? Understanding the Impact of Influencer VPN Ads",
    "HawkEye: Statically and Accurately Profiling the Communication Cost of Models in Multi-party Learning",
    "Towards Understanding and Enhancing Security of Proof-of-Training for DNN Model Ownership Verification",
    "Predictive Response Optimization: Using Reinforcement Learning to Fight Online Social Network Abuse",
    "PRSA: Prompt Stealing Attacks against Real-World Prompt Services",
    "When LLMs Go Online: The Emerging Threat of Web-Enabled LLMs",
    '"I Cannot Write This Because It Violates Our Content Policy": Understanding Content Moderation Policies and User Experiences in Generative AI Products',
  ],
  icml: [
    "Sharp-MAML: Sharpness-Aware Model-Agnostic Meta Learning",
    "Active Sampling for Min-Max Fairness",
    "Hierarchical Shrinkage: Improving the accuracy and interpretability of tree-based models",
    "Learning of Cluster-based Feature Importance for Electronic Health Record Time-series",
    "On the Convergence of the Shapley Value in Parametric Bayesian Learning Games",
    "How Faithful is your Synthetic Data? Sample-level Metrics for Evaluating and Auditing Generative Models",
    "A Natural Actor-Critic Framework for Zero-Sum Markov Games",
    "Deploying Convolutional Networks on Untrusted Platforms Using 2D Holographic Reduced Representations",
    "Optimistic Linear Support and Successor Features as a Basis for Optimal Policy Transfer",
    "Structured Stochastic Gradient MCMC",
    "XAI for Transformers: Better Explanations through Conservative Propagation",
    "Neuro-Symbolic Language Modeling with Automaton-augmented Retrieval",
    "Scalable First-Order Bayesian Optimization via Structured Automatic Differentiation",
    "Thresholded Lasso Bandit",
    "Gradient Based Clustering",
    "Understanding Gradient Descent on the Edge of Stability in Deep Learning",
    "Do More Negative Samples Necessarily Hurt In Contrastive Learning?",
    "Proving Theorems using Incremental Learning and Hindsight Experience Replay",
    // ICML 2025 採択の自己教師あり学習（arXiv コメントで確定）。data2vec 系クエリの
    // 語彙（self/supervised）を icml プロファイルに付与する。テストセットと重複なし。
    "Self-supervised Adversarial Purification for Graph Neural Networks",
    "HGOT: Self-supervised Heterogeneous Graph Neural Network with Optimal Transport",
    // R19: 語境界導入で data の部分一致（data2vec の造語内 data）が消えた分を
    // speech/vision 語彙で補う（ICML 2025 採択、PMLR 267 / arXiv コメントで確定）。
    "Do Not Mimic My Voice: Speaker Identity Unlearning for Zero-Shot Text-to-Speech",
  ],
};

/** 会議プロファイル文（カテゴリは正式名で展開）。
 * 多言語モデル用（forMulti）は、日本語名の会議にカテゴリの日本語キーワードを付与して
 * 日本語クエリから検索可能にする。英語モデルは日本語キーワードがノイズになるため
 * 付与しない（言語別の埋め込みを実測で分離した設計）。 */
function profileTexts(
  confs: Array<Record<string, unknown>>,
  catNames: Record<string, string>,
  forMulti: boolean,
): { keys: string[]; texts: string[] } {
  const keys: string[] = [];
  const texts: string[] = [];
  for (const c of confs) {
    const key = String(c.key ?? "");
    // カテゴリは短いキー（systems 等）より正式名（Systems, Architecture and Storage）で
    // 埋め込む方がセマンティック品質が高い（ベンチマークで実測）。
    const cats = (c.categories as string[] | null) ?? [];
    const catText = cats.map((k) => catNames[k] || k).join(" ");
    const name = `${String(c.title ?? "")} ${String(c.full_name ?? "")}`;
    // 多言語モデル用: 日本語名の会議に日本語の分野語を付与（クエリ側の日本語語彙と一致させる）
    const jpKw = forMulti && hasJapanese(name) ? cats.map((k) => JP_CAT_KW[k] || "").join(" ") : "";
    // 実採択論文タイトル（あれば）でプロファイルを強化。英語モデルにのみ付与
    // （R12 実測: multi にも付けると日本語クエリの sem ランキングを乱す — 言語別分離設計）。
    // R13 実測: 「タイトル個別ベクトルの平均」方式（会議名 + 各タイトルを別々に埋めて
    // 平均）は golden top1 +2 エントリだが top5 -2・EN 合成 -3.6 で総合的に悪化 → 不採用。
    // 連結 mean pooling が最良（golden top5 73.5% / EN 合成 85.0%）。
    // R14 実測: rtss/ecrts は論文が多様（scheduling/WCET/TSN/AI/FPGA）で平均重心が
    // 汎用化し、無関係クエリ（memory safety 等）を奪う。埋め込みは会議名中心に保ち、
    // papers は語彙一致（scoreLine）でのみ使う。
    // usenix-security も 24 本が極めて多様（crypto/ML/web/ハードウェア/ブロックチェーン）で
    // 重心が汎用化しやすいため vocab-only（R15 実測で決定）
    // R17 A/B: icdcs を vocab-only にすると golden top5 65.7→62.9 に悪化（icdcs 自身の
    // golden 7 件を sem で拾う正の効果が奪取を上回る）→ 埋め込みは従来どおり維持。
    const skipEmb = SKIP_EMB_KEYS.has(key);
    const papers = !forMulti && !skipEmb ? (VENUE_PAPERS[key] ?? []).slice(0, 8).join(" . ") : "";
    const parts = [
      String(c.title ?? ""),
      String(c.full_name ?? ""),
      catText,
      jpKw,
      ((c.tags as string[] | null) ?? []).join(" "),
      papers,
    ];
    const text = parts.filter(Boolean).join(" ").trim();
    keys.push(key);
    texts.push(text || key);
  }
  return { keys, texts };
}

/** 1 モデルぶんの埋め込み表 {key: number[]} を生成する。
 * keys に同じ key が複数回現れる場合（会議名 + 各代表論文タイトル）は、
 * その平均ベクトルを返す（R13: 会議の採択領域の重心にする）。 */
async function embedSet(
  model: string,
  texts: string[],
  keys: string[],
): Promise<Record<string, number[]>> {
  const extractor = await getExtractor(model);
  const sums = new Map<string, number[]>();
  const counts = new Map<string, number>();
  // メモリ節約のためバッチで処理
  const batch = 128;
  for (let start = 0; start < texts.length; start += batch) {
    const chunk = texts.slice(start, start + batch);
    const output = await extractor(chunk, { pooling: "mean", normalize: true });
    const tensors = Array.isArray(output) ? output : [output];
    let index = 0;
    for (const tensor of tensors) {
      const dims = tensor.dims;
      const n = dims.length >= 1 ? dims[0] : 1;
      const width = dims.length >= 2 ? dims[1] : EMBEDDING_DIM;
      const arr = Array.from(tensor.data as Float32Array | ArrayLike<number>);
      for (let i = 0; i < n; i++) {
        const key = keys[start + index];
        if (key !== undefined) {
          const vec = arr.slice(i * width, (i + 1) * width);
          const prev = sums.get(key);
          if (!prev) {
            sums.set(key, vec);
          } else {
            for (let d = 0; d < width; d++) prev[d] += vec[d];
          }
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        index += 1;
      }
    }
  }
  const out: Record<string, number[]> = {};
  for (const [key, sum] of sums) {
    const c = counts.get(key) ?? 1;
    const avg = sum.map((v) => v / c);
    const norm = Math.sqrt(avg.reduce((a, v) => a + v * v, 0)) || 1;
    out[key] = avg.map((v) => round6(v / norm));
  }
  return out;
}

/** 各テキストを個別ベクトルとして埋め込む（平均しない）。max 類似度用。 */
async function embedEach(model: string, texts: string[]): Promise<number[][]> {
  const extractor = await getExtractor(model);
  const out: number[][] = [];
  const batch = 128;
  for (let start = 0; start < texts.length; start += batch) {
    const chunk = texts.slice(start, start + batch);
    const output = await extractor(chunk, { pooling: "mean", normalize: true });
    const tensors = Array.isArray(output) ? output : [output];
    for (const tensor of tensors) {
      const dims = tensor.dims;
      const n = dims.length >= 1 ? dims[0] : 1;
      const width = dims.length >= 2 ? dims[1] : EMBEDDING_DIM;
      const arr = Array.from(tensor.data as Float32Array | ArrayLike<number>);
      for (let i = 0; i < n; i++) {
        const vec = arr.slice(i * width, (i + 1) * width);
        const norm = Math.sqrt(vec.reduce((a, v) => a + v * v, 0)) || 1;
        out.push(vec.map((v) => round6(v / norm)));
      }
    }
  }
  return out;
}

const SKIP_EMB_KEYS = new Set(["rtss", "ecrts", "usenix-security"]);

export async function buildEmbeddings(
  dataPath: string,
  outPath: string,
): Promise<Record<string, number[]>> {
  const data = JSON.parse(readFileSync(dataPath, "utf8")) as {
    conferences: Array<Record<string, unknown>>;
    categories?: Record<string, string>;
  };
  const catNames = (data.categories ?? {}) as Record<string, string>;
  const en = profileTexts(data.conferences, catNames, false);
  const multiTexts = profileTexts(data.conferences, catNames, true);

  // 言語適応型デュアルモデル（実測ベース）:
  // 英語は all-MiniLM-L6-v2（EN top1 80.1%）、日本語は paraphrase-multilingual
  // （JP top1 19.0% → 42.9%）。一方だけだと他方が落ちるため両方持つ。
  // 多言語側は日本語会議に日本語キーワードを付与（国内研究会の検索改善、実測済み）。
  const out = await embedSet(EMBEDDING_MODEL, en.texts, en.keys);
  const multi = await embedSet(EMBEDDING_MULTI_MODEL, multiTexts.texts, multiTexts.keys);

  // skipEmb 会議（rtss/ecrts/usenix-security）の論文個別ベクトル（R16）。
  // R14 で「多様な論文の平均重心の汎用化」が判明し埋め込みから外したが、その副作用で
  // 会議名のみの埋め込みになり実論文タイトルからセマンティックに発見されなくなった
  // （golden EN top1 15.8% vs top5 63.2% の乖離の主因）。R13 の「個別ベクトルの平均」は
  // 却下済みのため、max 類似度（クエリが採択論文のどれかに近ければ会議に近い）を
  // A/B する。英語モデルのみ（R12 の言語別分離: multi に英語論文語彙を混ぜると
  // 日本語クエリの順位を乱す）。
  const paperVecs: Record<string, number[][]> = {};
  // R16 A/B: rtss/ecrts は論文が多様（22+9 本）で max が「1 本でも近い」誤マッチを
  // 起こす（Beehive→rtss 50%、BULKHEAD→rtss 38% 等の実測）。usenix-security のみ
  // paperVecs を付与し、rtss/ecrts は R14 の「語彙のみ」を維持する。
  // R17 A/B 結果: ches を paperVecs に足すと top5 65.7→64.3 に悪化（FPGA/AES 語彙が
  // BULKHEAD/Beehive 等を奪う）→ usenix-security のみ維持。
  // R20 A/B: rtss を再追加（Timely Classification 対策）。R16 で「多様な papers の
  // max 誤爆」（Beehive→rtss 50% 等）で却下されたが、R19 の語境界・GENERIC 導入後に
  // 再検証する。golden EN 全体で悪化しなければ採用、悪化すれば usenix のみに戻す。
  // R21 A/B: rtas を試すと top1 +2.5pt だが top5 −2.5pt（既存 2 件
  // CounterSEVeillance/One-Size-Fits-None を奪い新規獲得 0）→ 不採用。
  // rtas は VENUE_PAPERS 語彙のみで 8 件中 6 件 top5 を達成。
  for (const key of ["usenix-security", "rtss"]) {
    const papers = VENUE_PAPERS[key] ?? [];
    if (!papers.length) continue;
    // 論文タイトルを**個別に**埋め込む（平均しない — max 類似度で使うため）。
    // embedSet は key ごとに平均するので使えない。
    const vecs = await embedEach(EMBEDDING_MODEL, papers);
    paperVecs[key] = vecs;
  }

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(
    outPath,
    JSON.stringify({
      model: EMBEDDING_MODEL,
      dim: EMBEDDING_DIM,
      embeddings: out,
      multi: {
        model: EMBEDDING_MULTI_MODEL,
        dim: EMBEDDING_DIM,
        embeddings: multi,
      },
      paperVecs,
    }),
    "utf8",
  );
  return out;
}

async function main(argv: string[]): Promise<number> {
  const args = argv.slice(2);
  if (args.length !== 2) {
    process.stderr.write("usage: node src/embeddings.ts <data.json> <embeddings.json>\n");
    return 2;
  }
  const dataPath = args[0];
  const outPath = args[1];
  let dataExists = true;
  try {
    readFileSync(dataPath);
  } catch {
    dataExists = false;
  }
  if (!dataExists) {
    process.stderr.write(`data not found: ${dataPath}\n`);
    return 1;
  }
  let outExists = false;
  try {
    readFileSync(outPath);
    outExists = true;
  } catch {
    outExists = false;
  }
  if (outExists) {
    process.stderr.write(`embeddings already exist: ${outPath} (skip)\n`);
    return 0;
  }
  const out = await buildEmbeddings(dataPath, outPath);
  console.log(`embeddings written: ${Object.keys(out).length} conferences -> ${outPath}`);
  return 0;
}

const isMain = process.argv[1]?.endsWith("embeddings.ts");
if (isMain) {
  main(process.argv).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(err);
      process.exitCode = 1;
    },
  );
}
