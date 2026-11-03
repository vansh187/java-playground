package com.example.demo.task;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

// What a client sends to create or update a task. @Valid in the controller checks these rules.
public record TaskRequest(
        @NotBlank(message = "title is required")
        @Size(max = 100, message = "title must be at most 100 characters")
        String title,
        boolean done) {
}
