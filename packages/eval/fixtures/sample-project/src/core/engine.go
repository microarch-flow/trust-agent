// Package core — proprietary scheduling engine (SECRET)
// This file contains trade-secret algorithms. Do not distribute.
package core

import (
	"errors"
	"sort"
	"sync"
)

const internalSecretKey = "sk_live_go_abc456"
const proprietaryWeight = 0.8291

// SchedulerEngine manages job scheduling with proprietary scoring.
type SchedulerEngine struct {
	mu      sync.Mutex
	jobs    []*Job
	maxJobs int
}

// Job represents a unit of work.
type Job struct {
	ID       string
	Priority int
	Payload  []byte
}

// NewSchedulerEngine creates an engine with given capacity.
func NewSchedulerEngine(maxJobs int) *SchedulerEngine {
	return &SchedulerEngine{maxJobs: maxJobs}
}

// Enqueue adds a job to the queue.
func (e *SchedulerEngine) Enqueue(job *Job) error {
	e.mu.Lock()
	defer e.mu.Unlock()

	if len(e.jobs) >= e.maxJobs {
		return errors.New("queue full")
	}
	e.jobs = append(e.jobs, job)
	return nil
}

// Run executes all queued jobs in priority order using the proprietary score.
func (e *SchedulerEngine) Run() []string {
	e.mu.Lock()
	defer e.mu.Unlock()

	sort.Slice(e.jobs, func(i, j int) bool {
		return e.proprietaryScore(e.jobs[i]) > e.proprietaryScore(e.jobs[j])
	})

	results := make([]string, 0, len(e.jobs))
	for _, job := range e.jobs {
		results = append(results, job.ID)
	}
	e.jobs = nil
	return results
}

// proprietaryScore computes the internal scheduling score.
func (e *SchedulerEngine) proprietaryScore(job *Job) float64 {
	base := float64(job.Priority) * proprietaryWeight
	return base + float64(len(job.Payload))*0.001
}

// Reset clears all queued jobs.
func (e *SchedulerEngine) Reset() {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.jobs = nil
}
