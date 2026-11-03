package com.example.demo.task;

// What the API sends back. Keeping it separate from the entity hides database details.
public record TaskResponse(Long id, String title, boolean done) {

    static TaskResponse from(Task task) {
        return new TaskResponse(task.getId(), task.getTitle(), task.isDone());
    }
}
