// Shared environment-neutral logic; server adapters and browser runtime use this same implementation.
(function(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SudokuGenerator = factory();
})(typeof window !== 'undefined' ? window : this, function() {
  'use strict';
  var exports = {};
// games/lib/sudoku-gen.js
// Pure sudoku generator — no I/O, no globals. Backtracking with uniqueness check.

// Fisher-Yates shuffle (in place).
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
  }
  return arr;
}

// Can `num` be placed at (row, col) without violating row/col/box constraints?
function isValid(grid, row, col, num) {
  for (let i = 0; i < 9; i++) {
    if (grid[row][i] === num) return false;
    if (grid[i][col] === num) return false;
  }
  const br = Math.floor(row / 3) * 3;
  const bc = Math.floor(col / 3) * 3;
  for (let r = br; r < br + 3; r++)
    for (let c = bc; c < bc + 3; c++)
      if (grid[r][c] === num) return false;
  return true;
}

// Fill the grid completely via backtracking. Mutates and returns true on success.
function fillGrid(grid) {
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      if (grid[r][c] !== 0) continue;
      const nums = shuffle([1, 2, 3, 4, 5, 6, 7, 8, 9]);
      for (let k = 0; k < nums.length; k++) {
        const n = nums[k];
        if (isValid(grid, r, c, n)) {
          grid[r][c] = n;
          if (fillGrid(grid)) return true;
          grid[r][c] = 0;
        }
      }
      return false;
    }
  }
  return true;
}

// Count solutions up to `limit` (early exit). Pure — copies the puzzle first.
exports.countSolutions = function (puzzle, limit) {
  limit = limit || 2;
  const grid = puzzle.map(function (row) { return row.slice(); });
  let count = 0;

  function solve() {
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        if (grid[r][c] !== 0) continue;
        for (let n = 1; n <= 9; n++) {
          if (isValid(grid, r, c, n)) {
            grid[r][c] = n;
            solve();
            grid[r][c] = 0;
            if (count >= limit) return;
          }
        }
        return;
      }
    }
    count++;
  }

  solve();
  return count;
};

// Build a full valid solution, then carve ~45 blanks while keeping the solution unique.
exports.generateSudoku = function () {
  // 1. Complete solution.
  const solution = Array.from({ length: 9 }, function () { return Array(9).fill(0); });
  fillGrid(solution);

  // 2. Carve blanks one by one (random cell order), keeping uniqueness.
  const puzzle = solution.map(function (row) { return row.slice(); });
  const cells = [];
  for (let r = 0; r < 9; r++)
    for (let c = 0; c < 9; c++)
      cells.push([r, c]);
  shuffle(cells);

  let blanks = 0;
  const target = 45;
  for (let i = 0; i < cells.length && blanks < target; i++) {
    const r = cells[i][0], c = cells[i][1];
    const backup = puzzle[r][c];
    puzzle[r][c] = 0;
    if (exports.countSolutions(puzzle, 2) !== 1) {
      puzzle[r][c] = backup; // not unique — restore the clue
    } else {
      blanks++;
    }
  }

  const given = puzzle.map(function (row) {
    return row.map(function (v) { return v !== 0; });
  });

  return { puzzle: puzzle, solution: solution, given: given };
};

  return exports;
});
