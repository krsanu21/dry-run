import type { ArgConversion, Language, RunMode } from "../trace/schema";

/**
 * Built-in learning examples. Every example is real source code executed by
 * the real tracer — there are no prerecorded traces in the product UI.
 * tests/unit/examples.test.ts runs each one and asserts on intermediate states.
 */

export interface ExampleTest {
  name: string;
  args: string[];
  expected?: string;
  conversions?: ArgConversion[];
  stdin?: string;
}

export interface Example {
  id: string;
  title: string;
  topic: string;
  language: Language;
  stage: "complete" | "unfinished" | "buggy";
  /** One sentence: what to watch in the visualization. */
  watch: string;
  mode: RunMode;
  entry?: string;
  source: string;
  tests: ExampleTest[];
  fragment?: { initialState: string; setup: string; startLine: number; endLine: number };
}

const py = String.raw;

export const EXAMPLES: Example[] = [
  {
    id: "two-sum",
    title: "Two Sum",
    topic: "Hash map",
    language: "python",
    stage: "complete",
    watch: "Watch `seen` fill up while `i` walks the array; the answer appears when a complement is already in the map.",
    mode: "function",
    entry: "Solution.twoSum",
    source: py`from typing import List

class Solution:
    def twoSum(self, nums: List[int], target: int) -> List[int]:
        seen = {}  # value -> index
        for i, num in enumerate(nums):
            need = target - num
            if need in seen:
                return [seen[need], i]
            seen[num] = i
        return []
`,
    tests: [
      { name: "Example 1", args: ["[2, 7, 11, 15]", "9"], expected: "[0, 1]" },
      { name: "Example 2", args: ["[3, 2, 4]", "6"], expected: "[1, 2]" },
      { name: "Duplicates", args: ["[3, 3]", "6"], expected: "[0, 1]" },
    ],
  },
  {
    id: "two-sum-unfinished",
    title: "Two Sum — work in progress",
    topic: "Hash map",
    language: "python",
    stage: "unfinished",
    watch: "The loop body is only half written and there is no return yet: the trace shows `seen` growing and the method returning None.",
    mode: "function",
    entry: "Solution.twoSum",
    source: py`from typing import List

class Solution:
    def twoSum(self, nums: List[int], target: int) -> List[int]:
        seen = {}
        for i, num in enumerate(nums):
            need = target - num
            # TODO: check whether we have already seen need
            seen[num] = i
        # TODO: return the answer
`,
    tests: [{ name: "Example 1", args: ["[2, 7, 11, 15]", "9"], expected: "[0, 1]" }],
  },
  {
    id: "reverse-array",
    title: "Reverse an array in place",
    topic: "Two pointers",
    language: "python",
    stage: "complete",
    watch: "`l` and `r` move toward each other; each swap changes two cells of the same list.",
    mode: "function",
    entry: "Solution.reverse",
    source: py`class Solution:
    def reverse(self, nums):
        l, r = 0, len(nums) - 1
        while l < r:
            nums[l], nums[r] = nums[r], nums[l]
            l += 1
            r -= 1
        return nums
`,
    tests: [
      { name: "Odd length", args: ["[1, 2, 3, 4, 5]"], expected: "[5, 4, 3, 2, 1]" },
      { name: "Even length", args: ["[1, 2, 3, 4]"], expected: "[4, 3, 2, 1]" },
      { name: "Empty", args: ["[]"], expected: "[]" },
    ],
  },
  {
    id: "reverse-array-buggy",
    title: "Reverse an array — buggy pointers",
    topic: "Two pointers",
    language: "python",
    stage: "buggy",
    watch: "Only `l` moves, so `r` keeps swapping into the same cell. Find the step where the result stops being a reversal.",
    mode: "function",
    entry: "Solution.reverse",
    source: py`class Solution:
    def reverse(self, nums):
        l, r = 0, len(nums) - 1
        while l < r:
            nums[l], nums[r] = nums[r], nums[l]
            l += 1
            # forgot to move r
        return nums
`,
    tests: [{ name: "Odd length", args: ["[1, 2, 3, 4, 5]"], expected: "[5, 4, 3, 2, 1]" }],
  },
  {
    id: "sliding-window",
    title: "Longest substring without repeating characters",
    topic: "Sliding window",
    language: "python",
    stage: "complete",
    watch: "The window is `s[left..right]`; `last` remembers where each character was seen and `left` jumps past repeats.",
    mode: "function",
    entry: "Solution.lengthOfLongestSubstring",
    source: py`class Solution:
    def lengthOfLongestSubstring(self, s: str) -> int:
        last = {}
        left = 0
        best = 0
        for right in range(len(s)):
            ch = s[right]
            if ch in last and last[ch] >= left:
                left = last[ch] + 1
            last[ch] = right
            best = max(best, right - left + 1)
        return best
`,
    tests: [
      { name: "abcabcbb", args: ['"abcabcbb"'], expected: "3" },
      { name: "bbbbb", args: ['"bbbbb"'], expected: "1" },
      { name: "pwwkew", args: ['"pwwkew"'], expected: "3" },
    ],
  },
  {
    id: "grid-bfs",
    title: "Shortest path in a grid (BFS)",
    topic: "BFS on a grid",
    language: "python",
    stage: "complete",
    watch: "Cells enter the queue in distance order; `dist` fills in like a wave from the start cell.",
    mode: "function",
    entry: "Solution.shortestPath",
    source: py`from collections import deque
from typing import List

class Solution:
    def shortestPath(self, grid: List[List[int]]) -> int:
        rows, cols = len(grid), len(grid[0])
        dist = [[-1] * cols for _ in range(rows)]
        dist[0][0] = 0
        queue = deque([(0, 0)])
        while queue:
            r, c = queue.popleft()
            for dr, dc in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                nr, nc = r + dr, c + dc
                if 0 <= nr < rows and 0 <= nc < cols and grid[nr][nc] == 0 and dist[nr][nc] == -1:
                    dist[nr][nc] = dist[r][c] + 1
                    queue.append((nr, nc))
        return dist[rows - 1][cols - 1]
`,
    tests: [
      { name: "3x3 open", args: ["[[0,0,0],[1,1,0],[0,0,0]]"], expected: "4" },
      { name: "Blocked", args: ["[[0,1],[1,0]]"], expected: "-1" },
    ],
  },
  {
    id: "dfs-components",
    title: "Connected components (recursive DFS)",
    topic: "Recursive DFS",
    language: "python",
    stage: "complete",
    watch: "Each recursive `dfs` call is a stack frame; `visited` grows as the recursion explores one component at a time.",
    mode: "function",
    entry: "Solution.countComponents",
    source: py`from typing import List

class Solution:
    def countComponents(self, n: int, edges: List[List[int]]) -> int:
        graph = {i: [] for i in range(n)}
        for a, b in edges:
            graph[a].append(b)
            graph[b].append(a)
        visited = set()

        def dfs(node):
            visited.add(node)
            for nei in graph[node]:
                if nei not in visited:
                    dfs(nei)

        components = 0
        for node in range(n):
            if node not in visited:
                components += 1
                dfs(node)
        return components
`,
    tests: [
      { name: "Two components", args: ["5", "[[0,1],[1,2],[3,4]]"], expected: "2" },
      { name: "One component", args: ["4", "[[0,1],[1,2],[2,3]]"], expected: "1" },
    ],
  },
  {
    id: "house-robber",
    title: "House Robber (1-D DP)",
    topic: "1-D dynamic programming",
    language: "python",
    stage: "complete",
    watch: "Each `dp[i]` is computed from `dp[i-1]` and `dp[i-2]` — the cells read by the current line are outlined.",
    mode: "function",
    entry: "Solution.rob",
    source: py`from typing import List

class Solution:
    def rob(self, nums: List[int]) -> int:
        if not nums:
            return 0
        dp = [0] * (len(nums) + 1)
        dp[1] = nums[0]
        for i in range(2, len(nums) + 1):
            dp[i] = max(dp[i - 1], dp[i - 2] + nums[i - 1])
        return dp[len(nums)]
`,
    tests: [
      { name: "Example 1", args: ["[1, 2, 3, 1]"], expected: "4" },
      { name: "Example 2", args: ["[2, 7, 9, 3, 1]"], expected: "12" },
    ],
  },
  {
    id: "house-robber-unfinished",
    title: "House Robber — transition not written yet",
    topic: "1-D dynamic programming",
    language: "python",
    stage: "unfinished",
    watch: "The base cases are set but the transition is a TODO, so the table never changes after `dp[1]`.",
    mode: "function",
    entry: "Solution.rob",
    source: py`from typing import List

class Solution:
    def rob(self, nums: List[int]) -> int:
        dp = [0] * (len(nums) + 1)
        dp[1] = nums[0]
        for i in range(2, len(nums) + 1):
            pass  # TODO: dp[i] = ?
        return dp[len(nums)]
`,
    tests: [{ name: "Example 2", args: ["[2, 7, 9, 3, 1]"], expected: "12" }],
  },
  {
    id: "lcs",
    title: "Longest common subsequence (2-D DP)",
    topic: "2-D dynamic programming",
    language: "python",
    stage: "complete",
    watch: "`dp[i][j]` depends on its top, left, and top-left neighbours; `i` and `j` also index into the two strings.",
    mode: "function",
    entry: "Solution.longestCommonSubsequence",
    source: py`class Solution:
    def longestCommonSubsequence(self, text1: str, text2: str) -> int:
        m, n = len(text1), len(text2)
        dp = [[0] * (n + 1) for _ in range(m + 1)]
        for i in range(1, m + 1):
            for j in range(1, n + 1):
                if text1[i - 1] == text2[j - 1]:
                    dp[i][j] = dp[i - 1][j - 1] + 1
                else:
                    dp[i][j] = max(dp[i - 1][j], dp[i][j - 1])
        return dp[m][n]
`,
    tests: [
      { name: "abcde / ace", args: ['"abcde"', '"ace"'], expected: "3" },
      { name: "abc / def", args: ['"abc"', '"def"'], expected: "0" },
    ],
  },
  {
    id: "kth-largest",
    title: "Kth largest element (heapq)",
    topic: "Heap",
    language: "python",
    stage: "complete",
    watch: "`heap` is a min-heap of size k: see both its array and tree shape; the root is always the k-th largest so far.",
    mode: "function",
    entry: "Solution.findKthLargest",
    source: py`import heapq
from typing import List

class Solution:
    def findKthLargest(self, nums: List[int], k: int) -> int:
        heap = []
        for num in nums:
            heapq.heappush(heap, num)
            if len(heap) > k:
                heapq.heappop(heap)
        return heap[0]
`,
    tests: [
      { name: "Example 1", args: ["[3, 2, 1, 5, 6, 4]", "2"], expected: "5" },
      { name: "Example 2", args: ["[3, 2, 3, 1, 2, 4, 5, 5, 6]", "4"], expected: "4" },
    ],
  },
  {
    id: "merge-intervals",
    title: "Merge intervals",
    topic: "Intervals",
    language: "python",
    stage: "complete",
    watch: "After sorting, each interval either extends the last merged interval or starts a new one.",
    mode: "function",
    entry: "Solution.merge",
    source: py`from typing import List

class Solution:
    def merge(self, intervals: List[List[int]]) -> List[List[int]]:
        intervals.sort(key=lambda iv: iv[0])
        merged = []
        for start, end in intervals:
            if merged and start <= merged[-1][1]:
                merged[-1][1] = max(merged[-1][1], end)
            else:
                merged.append([start, end])
        return merged
`,
    tests: [
      { name: "Example 1", args: ["[[1,3],[2,6],[8,10],[15,18]]"], expected: "[[1,6],[8,10],[15,18]]" },
      { name: "Touching", args: ["[[1,4],[4,5]]"], expected: "[[1,5]]" },
    ],
  },
  {
    id: "reverse-linked-list",
    title: "Reverse a linked list",
    topic: "Linked list",
    language: "python",
    stage: "complete",
    watch: "Each iteration flips one `.next` arrow; `prev`, `curr`, and `nxt` walk along the nodes.",
    mode: "function",
    entry: "Solution.reverseList",
    source: py`from typing import Optional

# class ListNode:
#     def __init__(self, val=0, next=None):
#         self.val = val
#         self.next = next

class Solution:
    def reverseList(self, head: Optional[ListNode]) -> Optional[ListNode]:
        prev = None
        curr = head
        while curr:
            nxt = curr.next
            curr.next = prev
            prev = curr
            curr = nxt
        return prev
`,
    tests: [
      { name: "Five nodes", args: ["[1, 2, 3, 4, 5]"], expected: "[5, 4, 3, 2, 1]", conversions: ["linked-list"] },
      { name: "Two nodes", args: ["[1, 2]"], expected: "[2, 1]", conversions: ["linked-list"] },
    ],
  },
  {
    id: "reverse-linked-list-unfinished",
    title: "Reverse a linked list — unfinished loop",
    topic: "Linked list",
    language: "python",
    stage: "unfinished",
    watch: "`curr.next = prev` cuts the list before `curr` can advance — see where the remaining nodes become unreachable.",
    mode: "function",
    entry: "Solution.reverseList",
    source: py`from typing import Optional

class Solution:
    def reverseList(self, head: Optional[ListNode]) -> Optional[ListNode]:
        prev = None
        curr = head
        while curr:
            curr.next = prev
            prev = curr
            curr = curr.next  # hmm, what is curr.next now?
        return prev
`,
    tests: [{ name: "Five nodes", args: ["[1, 2, 3, 4, 5]"], expected: "[5, 4, 3, 2, 1]", conversions: ["linked-list"] }],
  },
  {
    id: "inorder-traversal",
    title: "Binary tree inorder traversal",
    topic: "Binary tree",
    language: "python",
    stage: "complete",
    watch: "The recursion path is highlighted in the tree; values are appended to `out` in left–root–right order.",
    mode: "function",
    entry: "Solution.inorderTraversal",
    source: py`from typing import List, Optional

class Solution:
    def inorderTraversal(self, root: Optional[TreeNode]) -> List[int]:
        out = []

        def visit(node):
            if node is None:
                return
            visit(node.left)
            out.append(node.val)
            visit(node.right)

        visit(root)
        return out
`,
    tests: [
      { name: "Example", args: ["[4, 2, 6, 1, 3, 5, 7]"], expected: "[1, 2, 3, 4, 5, 6, 7]", conversions: ["binary-tree"] },
      { name: "Skewed", args: ["[1, null, 2, null, 3]"], expected: "[1, 2, 3]", conversions: ["binary-tree"] },
    ],
  },
  {
    id: "fragment-dp-transition",
    title: "Fragment: one DP transition",
    topic: "Fragment mode",
    language: "python",
    stage: "unfinished",
    watch: "Only the selected lines run, inside a harness function whose parameters are the initial state you provide.",
    mode: "fragment",
    source: py`for i in range(2, len(nums) + 1):
    dp[i] = max(dp[i - 1], dp[i - 2] + nums[i - 1])
`,
    tests: [],
    fragment: { initialState: '{\n  "nums": [2, 7, 9, 3, 1],\n  "dp": [0, 2, 0, 0, 0, 0]\n}', setup: "", startLine: 1, endLine: 2 },
  },
  {
    id: "generator-script",
    title: "Generators and output (script)",
    topic: "Script mode",
    language: "python",
    stage: "complete",
    watch: "A generator frame suspends at `yield` and resumes with the same frame identity; printed output accumulates.",
    mode: "script",
    source: py`def countdown(n):
    while n > 0:
        yield n
        n -= 1

for value in countdown(3):
    print("tick", value)
print("liftoff")
`,
    tests: [],
  },
  // ---- JavaScript ------------------------------------------------------------
  {
    id: "js-two-sum",
    title: "Two Sum",
    topic: "Hash map",
    language: "javascript",
    stage: "complete",
    watch: "The same trace schema drives the visualization for JavaScript: watch the Map fill and `i` advance.",
    mode: "function",
    entry: "twoSum",
    source: `/**
 * @param {number[]} nums
 * @param {number} target
 * @return {number[]}
 */
var twoSum = function (nums, target) {
  const seen = new Map();
  for (let i = 0; i < nums.length; i++) {
    const need = target - nums[i];
    if (seen.has(need)) return [seen.get(need), i];
    seen.set(nums[i], i);
  }
  return [];
};
`,
    tests: [
      { name: "Example 1", args: ["[2, 7, 11, 15]", "9"], expected: "[0, 1]" },
      { name: "Example 2", args: ["[3, 2, 4]", "6"], expected: "[1, 2]" },
    ],
  },
  {
    id: "js-reverse-linked-list",
    title: "Reverse a linked list",
    topic: "Linked list",
    language: "javascript",
    stage: "complete",
    watch: "Arrows flip one at a time; `prev` and `curr` are pointers into the same node objects.",
    mode: "function",
    entry: "reverseList",
    source: `/**
 * function ListNode(val, next) {
 *   this.val = (val === undefined ? 0 : val);
 *   this.next = (next === undefined ? null : next);
 * }
 */
function reverseList(head) {
  let prev = null;
  let curr = head;
  while (curr !== null) {
    const next = curr.next;
    curr.next = prev;
    prev = curr;
    curr = next;
  }
  return prev;
}
`,
    tests: [{ name: "Five nodes", args: ["[1, 2, 3, 4, 5]"], expected: "[5, 4, 3, 2, 1]", conversions: ["linked-list"] }],
  },
  {
    id: "js-max-depth",
    title: "Maximum depth of a binary tree",
    topic: "Binary tree",
    language: "javascript",
    stage: "complete",
    watch: "Every recursive call gets its own frame and its own `root`; return values flow back up the stack.",
    mode: "function",
    entry: "maxDepth",
    source: `function maxDepth(root) {
  if (root === null) return 0;
  const left = maxDepth(root.left);
  const right = maxDepth(root.right);
  return Math.max(left, right) + 1;
}
`,
    tests: [{ name: "Example", args: ["[3, 9, 20, null, null, 15, 7]"], expected: "3", conversions: ["binary-tree"] }],
  },
  {
    id: "js-sliding-window",
    title: "Minimum size subarray sum",
    topic: "Sliding window",
    language: "javascript",
    stage: "complete",
    watch: "`left` and `right` bound the window over `nums`; `sum` grows with `right` and shrinks with `left`.",
    mode: "function",
    entry: "minSubArrayLen",
    source: `function minSubArrayLen(target, nums) {
  let left = 0;
  let sum = 0;
  let best = Infinity;
  for (let right = 0; right < nums.length; right++) {
    sum += nums[right];
    while (sum >= target) {
      best = Math.min(best, right - left + 1);
      sum -= nums[left];
      left++;
    }
  }
  return best === Infinity ? 0 : best;
}
`,
    tests: [{ name: "Example 1", args: ["7", "[2, 3, 1, 2, 4, 3]"], expected: "2" }],
  },
];

export function exampleById(id: string): Example | undefined {
  return EXAMPLES.find((e) => e.id === id);
}
